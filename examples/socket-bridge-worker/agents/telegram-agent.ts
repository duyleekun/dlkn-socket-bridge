import { Agent, unstable_callable as callable } from "agents";
import QRCode from "qrcode";
import {
  createSession,
  transitionSession,
  invokeSessionMethod,
  selectSessionView,
  buildTelegramGetDifferenceParams,
  extractTelegramUpdatesState,
  classifyDecryptedFrame,
  getTlObjectClassName,
  parseRpcResultFrame,
  normalizeTlValue,
  type ApiMethodPath,
  type SessionSnapshot,
  type SessionCommand,
  type SessionEvent,
  type TelegramUpdatesState,
} from "gramjs-statemachine";
import { createSession as createBridgeSession, sendBytes, closeSession, getStatus } from "./shared/bridge-client";
import { normalizeUrl, resolveBridgeUrl } from "./shared/bridge-url";
import type {
  Env,
  TelegramState,
  TelegramPhase,
  SocketActivity,
  CallbackRecord,
  ParsedPacketEntry,
  ParsedPacketKind,
  BridgeStatusResponse,
} from "./shared/types";
import { DEFAULT_TELEGRAM_STATE } from "./shared/types";

// SQL private store helpers — never broadcast these
// Schema:
//   tg_session(key TEXT PRIMARY KEY, value TEXT)
//   tg_messages(id TEXT PK, peer_id TEXT, text TEXT, ts INTEGER, outgoing INTEGER)
//   tg_packets(id TEXT PK, data TEXT, ts INTEGER)   ← parsed MTProto frames

export class TelegramAgent extends Agent<Env, TelegramState> {
  initialState = DEFAULT_TELEGRAM_STATE;
  static readonly #UPDATES_STATE_KEY = "updates_state";

  // In-memory snapshot cache — shared across all concurrent requests on the
  // same DO instance. Written before any outbound frame is sent so that the
  // bridge callback (pushFrame) always finds the snapshot even if it arrives
  // before the SQL write is visible.
  #snapshotCache: SessionSnapshot | null = null;
  #manualSocketClose = false;

  // ── Private SQL helpers ─────────────────────────────────────────────────

  #initSchema() {
    this.sql`CREATE TABLE IF NOT EXISTS tg_session (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS tg_messages (
      id TEXT PRIMARY KEY,
      peer_id TEXT,
      text TEXT,
      ts INTEGER,
      outgoing INTEGER DEFAULT 0
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS tg_packets (
      id   TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      ts   INTEGER NOT NULL
    )`;
  }

  #getPrivate(key: string): string | null {
    const rows = this.sql<{ value: string }>`
      SELECT value FROM tg_session WHERE key = ${key}
    `;
    return rows[0]?.value ?? null;
  }

  #setPrivate(key: string, value: string): void {
    this.sql`
      INSERT INTO tg_session (key, value) VALUES (${key}, ${value})
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `;
  }

  #deletePrivate(key: string): void {
    this.sql`DELETE FROM tg_session WHERE key = ${key}`;
  }

  #loadSnapshot(): SessionSnapshot | null {
    if (this.#snapshotCache) return this.#snapshotCache;
    const raw = this.#getPrivate("snapshot");
    if (!raw) return null;
    try {
      const snap = JSON.parse(raw) as SessionSnapshot;
      this.#snapshotCache = snap;
      return snap;
    } catch {
      return null;
    }
  }

  #saveSnapshot(snap: SessionSnapshot): void {
    this.#snapshotCache = snap;
    this.#setPrivate("snapshot", JSON.stringify(snap));
  }

  #resolveRequestOrigin(origin?: string): string {
    if (origin) {
      const normalizedOrigin = normalizeUrl(origin);
      this.#setPrivate("request_origin", normalizedOrigin);
      return normalizedOrigin;
    }

    const persistedOrigin = this.#getPrivate("request_origin");
    if (!persistedOrigin) {
      throw new Error("Missing request origin");
    }
    return persistedOrigin;
  }

  #loadBridgeInfo(): { socketId: string; bridgeUrl: string; callbackKey: string } | null {
    const raw = this.#getPrivate("bridge_info");
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  #saveBridgeInfo(info: { socketId: string; bridgeUrl: string; callbackKey: string }): void {
    this.#setPrivate("bridge_info", JSON.stringify(info));
  }

  #loadUpdatesState(): TelegramUpdatesState | null {
    const raw = this.#getPrivate(TelegramAgent.#UPDATES_STATE_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as TelegramUpdatesState;
    } catch {
      return null;
    }
  }

  #saveUpdatesState(state: TelegramUpdatesState): void {
    this.#setPrivate(TelegramAgent.#UPDATES_STATE_KEY, JSON.stringify(state));
  }

  #parseNullableNumber(raw: string | null): number | null {
    if (!raw) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }

  #loadRecoveryState(): Pick<TelegramState, "lastEventSeq" | "lastEventAt" | "reconnectCount"> {
    return {
      lastEventSeq: this.#parseNullableNumber(this.#getPrivate("recovery_seq")),
      lastEventAt: this.#parseNullableNumber(this.#getPrivate("recovery_at")),
      reconnectCount: this.#parseNullableNumber(this.#getPrivate("reconnect_count")) ?? 0,
    };
  }

  #setRecoveryState(patch: Partial<Pick<TelegramState, "lastEventSeq" | "lastEventAt" | "reconnectCount">>): void {
    if (patch.lastEventSeq !== undefined) {
      if (patch.lastEventSeq === null) {
        this.#deletePrivate("recovery_seq");
      } else {
        this.#setPrivate("recovery_seq", String(patch.lastEventSeq));
      }
    }

    if (patch.lastEventAt !== undefined) {
      if (patch.lastEventAt === null) {
        this.#deletePrivate("recovery_at");
      } else {
        this.#setPrivate("recovery_at", String(patch.lastEventAt));
      }
    }

    if (patch.reconnectCount !== undefined) {
      this.#setPrivate("reconnect_count", String(patch.reconnectCount));
    }
  }

  #clearRecoveryState(): void {
    this.#deletePrivate("recovery_seq");
    this.#deletePrivate("recovery_at");
    this.#deletePrivate("reconnect_count");
    this.#deletePrivate(TelegramAgent.#UPDATES_STATE_KEY);
  }

  #syncRecoveryStateIntoBroadcast(): void {
    this.setState({
      ...this.state,
      ...this.#loadRecoveryState(),
      updatedAt: Date.now(),
    });
  }

  #requireReadySnapshot(): SessionSnapshot {
    const snapshot = this.#loadSnapshot();
    if (!snapshot || snapshot.value !== "ready") {
      throw new Error("Session is not authenticated");
    }
    return snapshot;
  }

  async #dispatchSessionMethod<M extends ApiMethodPath>(
    snapshot: SessionSnapshot,
    method: M,
    params: unknown,
  ): Promise<{ ok: true; msgId: string } | { ok: false; error: string }> {
    try {
      const result = await invokeSessionMethod(
        snapshot,
        method,
        params as never,
      );
      this.#saveSnapshot(result.snapshot);
      await this.#executeCommands(result.commands);
      await this.#applySnapshot(result.snapshot);
      this.#addActivity({
        kind: "frame_out",
        label: `RPC ${method}`,
      });
      return {
        ok: true,
        msgId: result.snapshot.context.lastMsgId,
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async #updateRecoveryFromEvents(
    snapshot: SessionSnapshot,
    events: SessionEvent[],
  ): Promise<void> {
    const nextFromSnapshot =
      typeof (snapshot as SessionSnapshot & { pts?: unknown }).pts === "number"
        ? Number((snapshot as SessionSnapshot & { pts?: unknown }).pts)
        : typeof (snapshot.context as SessionSnapshot["context"] & { pts?: unknown }).pts === "number"
          ? Number((snapshot.context as SessionSnapshot["context"] & { pts?: unknown }).pts)
          : null;

    if (nextFromSnapshot !== null) {
      const ts = Date.now();
      this.#setRecoveryState({ lastEventSeq: nextFromSnapshot, lastEventAt: ts });
      this.setState({ ...this.state, lastEventSeq: nextFromSnapshot, lastEventAt: ts, updatedAt: ts });
      return;
    }

    let updatesState = this.#loadUpdatesState();
    for (const event of events) {
      updatesState = await extractTelegramUpdatesState(event, updatesState, {
        updatedAt: Date.now(),
      }) ?? updatesState;
    }

    if (!updatesState) return;

    this.#saveUpdatesState(updatesState);
    this.#setRecoveryState({
      lastEventSeq: updatesState.pts,
      lastEventAt: updatesState.updatedAt,
    });
    this.setState({
      ...this.state,
      lastEventSeq: updatesState.pts,
      lastEventAt: updatesState.updatedAt,
      updatedAt: Date.now(),
    });
  }

  async #closePersistedBridge(): Promise<void> {
    const bridge = this.#loadBridgeInfo();
    if (!bridge) return;

    try {
      await closeSession(bridge.bridgeUrl, bridge.socketId);
    } catch {
      /* ignore */
    }

    await this.env.BRIDGE_KV.delete(`callback:${bridge.callbackKey}`);
    this.#deletePrivate("bridge_info");
  }

  async #reconnectAuthenticatedSession(
    snapshot: SessionSnapshot,
  ): Promise<void> {
    this.#manualSocketClose = false;
    await this.#closePersistedBridge();

    const bridgeUrl = resolveBridgeUrl(this.env.BRIDGE_URL);
    const requestOrigin = this.#resolveRequestOrigin();
    const callbackKey = crypto.randomUUID();

    const bridgeResp = await createBridgeSession(
      bridgeUrl,
      `mtproto-frame://${snapshot.context.dcIp}:${snapshot.context.dcPort}`,
      `${requestOrigin}/cb/${callbackKey}`,
    );

    const record: CallbackRecord = { platform: "telegram", instanceId: this.#instanceId() };
    await this.env.BRIDGE_KV.put(`callback:${callbackKey}`, JSON.stringify(record));

    this.#saveBridgeInfo({
      socketId: bridgeResp.socket_id,
      bridgeUrl,
      callbackKey,
    });

    const probe = await invokeSessionMethod(snapshot, "updates.GetState", undefined);
    this.#saveSnapshot(probe.snapshot);
    await this.#executeCommands(probe.commands);
    await this.#applySnapshot(probe.snapshot);
    this.setState({
      ...this.state,
      phase: "authenticated",
      socketStatus: "connecting",
      error: null,
      updatedAt: Date.now(),
    });
  }

  // ── Packet log SQL helpers (private — never broadcast raw) ─────────────

  static readonly #PACKET_SQL_LIMIT = 200;
  static readonly #PACKET_STATE_LIMIT = 50;

  #persistPackets(entries: ParsedPacketEntry[]): void {
    if (entries.length === 0) return;
    for (const e of entries) {
      this.sql`
        INSERT OR IGNORE INTO tg_packets (id, data, ts) VALUES (${e.id}, ${JSON.stringify(e)}, ${e.receivedAt})
      `;
    }
    // Prune to last N rows
    this.sql`
      DELETE FROM tg_packets WHERE id NOT IN (
        SELECT id FROM tg_packets ORDER BY ts DESC LIMIT ${TelegramAgent.#PACKET_SQL_LIMIT}
      )
    `;
  }

  #loadPacketsFromSql(limit = TelegramAgent.#PACKET_SQL_LIMIT): ParsedPacketEntry[] {
    const rows = this.sql<{ data: string }>`
      SELECT data FROM tg_packets ORDER BY ts DESC LIMIT ${limit}
    `;
    return rows
      .map((r) => { try { return JSON.parse(r.data) as ParsedPacketEntry; } catch { return null; } })
      .filter(Boolean)
      .reverse() as ParsedPacketEntry[];
  }

  // ── Safe instance name (workaround for workerd#2240) ───────────────────
  // this.name throws if called before the Agent framework sets it.
  // this.ctx.id.name is always available when the DO was created via idFromName().
  #instanceId(): string {
    try {
      return (this.ctx.id as DurableObjectId & { name?: string }).name ?? this.ctx.id.toString();
    } catch {
      return this.ctx.id.toString();
    }
  }

  // ── Activity log (bounded, last 20) ────────────────────────────────────

  #addActivity(activity: Omit<SocketActivity, "id" | "ts">): void {
    const entry: SocketActivity = {
      id: crypto.randomUUID(),
      ts: Date.now(),
      ...activity,
    };
    const current = this.state.socketActivity;
    const next = [...current, entry].slice(-20);
    this.setState({ ...this.state, socketActivity: next, updatedAt: Date.now() });
  }

  // ── Phase → state helpers ───────────────────────────────────────────────

  #phaseFromSnapshot(snap: SessionSnapshot): TelegramPhase {
    switch (snap.value) {
      case "handshake":
      case "authorizing":
        return "connecting";
      case "awaiting_code":
        return "waiting_code";
      case "awaiting_password":
        return "waiting_password";
      case "awaiting_qr_scan":
        return "waiting_qr_scan";
      case "ready":
        return "authenticated";
      case "error":
        return "error";
      default:
        return "connecting";
    }
  }

  async #applySnapshot(snap: SessionSnapshot): Promise<void> {
    this.#initSchema();
    this.#saveSnapshot(snap);
    const view = selectSessionView(snap);
    const phase = this.#phaseFromSnapshot(snap);

    const patch: Partial<TelegramState> = {
      phase,
      error:
        snap.value === "error"
          ? ((snap.context as unknown as { error?: { message?: string } }).error?.message ??
            "Unknown error")
          : null,
      updatedAt: Date.now(),
    };

    if (phase === "waiting_qr_scan") {
      if (view.qrLoginUrl) {
        // Convert tg:// deep-link → actual QR code PNG (data URL)
        try {
          const dataUrl = await QRCode.toDataURL(view.qrLoginUrl, {
            errorCorrectionLevel: "M",
            margin: 2,
            width: 256,
          });
          patch.qrCode = dataUrl;
        } catch {
          // Fallback: store raw URL; QRDisplay will handle it
          patch.qrCode = view.qrLoginUrl;
        }
        patch.qrExpiresAt = view.qrExpiresAt
          ? Number(view.qrExpiresAt) * 1000
          : Date.now() + 30_000;
      }
    } else {
      patch.qrCode = null;
      patch.qrExpiresAt = null;
    }

    if (phase === "authenticated" && snap.value === "ready") {
      const user = (
        snap.context as unknown as {
          user?: { id?: string | number; firstName?: string; lastName?: string; username?: string };
        }
      ).user;
      if (user) {
        patch.userProfile = {
          id: String(user.id ?? ""),
          firstName: user.firstName ?? "",
          lastName: user.lastName,
          username: user.username,
        };
      }
    }

    this.setState({ ...this.state, ...patch });
  }

  // ── Execute commands (send frames, reconnect) ──────────────────────────

  async #executeCommands(commands: SessionCommand[]): Promise<void> {
    this.#initSchema();
    for (const cmd of commands) {
      const bridge = this.#loadBridgeInfo();
      if (!bridge) {
        console.warn("[TelegramAgent] no bridge info, skipping command", cmd.type);
        continue;
      }

      if (cmd.type === "send_frame") {
        await sendBytes(bridge.bridgeUrl, bridge.socketId, cmd.frame);
        this.#addActivity({
          kind: "frame_out",
          label: `\u2192 frame (${cmd.frame.length}B)`,
          byteLen: cmd.frame.length,
        });
      } else if (cmd.type === "reconnect") {
        // Create a new bridge session for the new DC
        const newCallbackKey = crypto.randomUUID();
        const requestOrigin = this.#resolveRequestOrigin();
        const bridgeUrl = resolveBridgeUrl(this.env.BRIDGE_URL);

        const resp = await createBridgeSession(
          bridgeUrl,
          `mtproto-frame://${cmd.dcIp}:${cmd.dcPort}`,
          `${requestOrigin}/cb/${newCallbackKey}`,
        );

        // Update KV: register new callback key, remove old one
        const record: CallbackRecord = { platform: "telegram", instanceId: this.#instanceId() };
        await Promise.all([
          this.env.BRIDGE_KV.put(`callback:${newCallbackKey}`, JSON.stringify(record)),
          this.env.BRIDGE_KV.delete(`callback:${bridge.callbackKey}`),
        ]);

        // Close old socket
        try {
          await closeSession(bridge.bridgeUrl, bridge.socketId);
        } catch {
          /* ignore */
        }

        // Save new bridge info
        this.#saveBridgeInfo({
          socketId: resp.socket_id,
          bridgeUrl,
          callbackKey: newCallbackKey,
        });
        this.#addActivity({
          kind: "connected",
          label: `\u21BA reconnect DC ${cmd.dcIp}:${cmd.dcPort}`,
        });

        // Send first frame on new connection
        await sendBytes(bridgeUrl, resp.socket_id, cmd.firstFrame);
        this.#addActivity({
          kind: "frame_out",
          label: `\u2192 firstFrame (${cmd.firstFrame.length}B)`,
          byteLen: cmd.firstFrame.length,
        });
      }
    }
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  async onStart() {
    this.#initSchema();
    // Warm the in-memory snapshot cache from SQL on cold start so pushFrame
    // doesn't need a SQL read on its hot path.
    this.#snapshotCache = null;
    const snapshot = this.#loadSnapshot(); // populates #snapshotCache as a side-effect
    if (snapshot?.value === "ready") {
      await this.#applySnapshot(snapshot);
      this.setState({
        ...this.state,
        phase: "authenticated",
        socketStatus: "disconnected",
        error: null,
        updatedAt: Date.now(),
      });
    }
    this.#resetIfStale({ assumeBridgeDead: false });
    this.#syncRecoveryStateIntoBroadcast();
  }

  onConnect() {
    this.#resetIfStale({ assumeBridgeDead: false });
    this.#syncRecoveryStateIntoBroadcast();
  }

  // Reset any mid-flight phase that has no backing bridge connection.
  // Called both on cold start (onStart) and whenever a browser client connects
  // (onConnect), so a live DO with stale state also self-heals on reconnect.
  // Bridge info saved by a previous server run is always dead — we cannot
  // verify the socket is still alive without a round-trip, so we unconditionally
  // reset any mid-flight phase and clear the stale bridge info.
  #resetIfStale(options: { assumeBridgeDead: boolean }): void {
    const { phase } = this.state;
    const stale =
      phase === "connecting" ||
      phase === "waiting_qr_scan" ||
      phase === "qr_expired" ||
      phase === "waiting_phone" ||
      phase === "waiting_code" ||
      phase === "waiting_password" ||
      phase === "error";

    if (stale && (options.assumeBridgeDead || !this.#loadBridgeInfo())) {
      this.#snapshotCache = null;
      this.#deletePrivate("bridge_info");
      this.setState({
        ...this.state,
        ...this.#loadRecoveryState(),
        phase: "idle",
        socketStatus: "disconnected",
        error: null,
        updatedAt: Date.now(),
      });
    }
  }

  // ── @callable RPCs (browser → Agent via WebSocket) ─────────────────────

  @callable()
  async startAuth(input: {
    mode: "phone" | "qr";
    phoneNumber?: string;
    requestOrigin: string;
  }): Promise<{ ok: boolean; error?: string }> {
    try {
      this.#initSchema();
      this.#clearRecoveryState();
      this.#syncRecoveryStateIntoBroadcast();
      const bridgeUrl = resolveBridgeUrl(this.env.BRIDGE_URL);
      const requestOrigin = this.#resolveRequestOrigin(input.requestOrigin);
      const callbackKey = crypto.randomUUID();

      const initial = await createSession({
        apiId: this.env.TELEGRAM_API_ID,
        apiHash: this.env.TELEGRAM_API_HASH,
        dcMode: "production",
        authMode: input.mode,
        phone: input.mode === "phone" ? input.phoneNumber : undefined,
      });

      // Cache snapshot immediately — before any network I/O — so that the bridge
      // callback (pushFrame) can always find it even if it arrives concurrently.
      this.#saveSnapshot(initial.snapshot);
      console.log("[TelegramAgent.startAuth] snapshot saved, instanceId:", this.#instanceId(), "cacheSet:", this.#snapshotCache !== null);

      const bridgeResp = await createBridgeSession(
        bridgeUrl,
        `mtproto-frame://${initial.snapshot.context.dcIp}:${initial.snapshot.context.dcPort}`,
        `${requestOrigin}/cb/${callbackKey}`,
      );

      // Register callback routing in KV
      const record: CallbackRecord = { platform: "telegram", instanceId: this.#instanceId() };
      await this.env.BRIDGE_KV.put(`callback:${callbackKey}`, JSON.stringify(record));

      this.#saveBridgeInfo({
        socketId: bridgeResp.socket_id,
        bridgeUrl,
        callbackKey,
      });
      this.setState({
        ...this.state,
        phase: "connecting",
        socketStatus: "connecting",
        error: null,
        updatedAt: Date.now(),
      });
      this.#addActivity({ kind: "connected", label: "Bridge socket created" });

      // Save snapshot BEFORE executing commands — the bridge can call pushFrame
      // with the response before #executeCommands returns, and pushFrame needs
      // the snapshot to be present to process inbound frames correctly.
      await this.#applySnapshot(initial.snapshot);
      await this.#executeCommands(initial.commands);

      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.setState({ ...this.state, phase: "error", error: msg, updatedAt: Date.now() });
      return { ok: false, error: msg };
    }
  }

  @callable()
  async submitCode(input: { code: string }): Promise<{ ok: boolean; error?: string }> {
    try {
      this.#initSchema();
      const snap = this.#loadSnapshot();
      if (!snap || snap.value !== "awaiting_code") {
        return { ok: false, error: "Not in awaiting_code state" };
      }
      const result = await transitionSession(snap, { type: "submit_code", code: input.code });
      await this.#applySnapshot(result.snapshot);
      await this.#executeCommands(result.commands);
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.setState({ ...this.state, phase: "error", error: msg, updatedAt: Date.now() });
      return { ok: false, error: msg };
    }
  }

  @callable()
  async submitPassword(input: { password: string }): Promise<{ ok: boolean; error?: string }> {
    try {
      this.#initSchema();
      const snap = this.#loadSnapshot();
      if (!snap || snap.value !== "awaiting_password") {
        return { ok: false, error: "Not in awaiting_password state" };
      }
      const result = await transitionSession(snap, {
        type: "submit_password",
        password: input.password,
      });
      await this.#applySnapshot(result.snapshot);
      await this.#executeCommands(result.commands);
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.setState({ ...this.state, phase: "error", error: msg, updatedAt: Date.now() });
      return { ok: false, error: msg };
    }
  }

  @callable()
  async refreshQrToken(): Promise<{ ok: boolean; error?: string }> {
    try {
      this.#initSchema();
      const snap = this.#loadSnapshot();
      if (!snap) return { ok: false, error: "No session" };
      const result = await transitionSession(snap, { type: "refresh_qr" });
      await this.#applySnapshot(result.snapshot);
      await this.#executeCommands(result.commands);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  @callable()
  async logout(): Promise<{ ok: boolean }> {
    try {
      this.#initSchema();
      await this.#closePersistedBridge();
      this.#snapshotCache = null;
      this.#deletePrivate("snapshot");
      this.#clearRecoveryState();
      this.setState({ ...DEFAULT_TELEGRAM_STATE, updatedAt: Date.now() });
      return { ok: true };
    } catch {
      return { ok: true };
    }
  }

  @callable()
  async getBridgeSocketHealth(): Promise<
    { ok: true; status: BridgeStatusResponse }
    | { ok: false; error: string }
  > {
    try {
      this.#initSchema();
      const bridge = this.#loadBridgeInfo();
      if (!bridge) {
        return { ok: false, error: "No active bridge socket" };
      }
      return {
        ok: true,
        status: await getStatus(bridge.bridgeUrl, bridge.socketId),
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  @callable()
  getTelegramUpdatesState(): TelegramUpdatesState | null {
    this.#initSchema();
    return this.#loadUpdatesState();
  }

  @callable()
  async telegramGetState(): Promise<
    { ok: true; msgId: string } | { ok: false; error: string }
  > {
    try {
      this.#initSchema();
      return this.#dispatchSessionMethod(
        this.#requireReadySnapshot(),
        "updates.GetState",
        undefined,
      );
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  @callable()
  async telegramGetDifference(): Promise<
    { ok: true; msgId: string } | { ok: false; error: string }
  > {
    try {
      this.#initSchema();
      const updatesState = this.#loadUpdatesState();
      if (!updatesState) {
        return { ok: false, error: "Missing updates state" };
      }
      return this.#dispatchSessionMethod(
        this.#requireReadySnapshot(),
        "updates.GetDifference",
        buildTelegramGetDifferenceParams(updatesState),
      );
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  @callable()
  async sendTelegramMethod(input: {
    method: string;
    params?: Record<string, unknown>;
  }): Promise<
    { ok: true; msgId: string } | { ok: false; error: string }
  > {
    try {
      this.#initSchema();
      const method = input.method.trim();
      if (!method) {
        return { ok: false, error: "Method is required" };
      }
      return this.#dispatchSessionMethod(
        this.#requireReadySnapshot(),
        method as ApiMethodPath,
        input.params ?? {},
      );
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  @callable()
  async closeCurrentSocket(): Promise<
    { ok: true } | { ok: false; error: string }
  > {
    try {
      this.#initSchema();
      this.#manualSocketClose = true;
      await this.#closePersistedBridge();
      this.#addActivity({
        kind: "disconnected",
        label: "Socket closed by user",
      });
      this.setState({
        ...this.state,
        socketStatus: "disconnected",
        error: null,
        updatedAt: Date.now(),
      });
      return { ok: true };
    } catch (err) {
      this.#manualSocketClose = false;
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  @callable()
  async recoverSession(input?: {
    requestOrigin?: string;
  }): Promise<
    | { ok: true; lastEventSeq: number | null; lastEventAt: number | null; reconnectCount: number }
    | { ok: false; error: string }
  > {
    try {
      this.#initSchema();
      this.#resolveRequestOrigin(input?.requestOrigin);
      const snapshot = this.#loadSnapshot();

      if (!snapshot) {
        this.setState({
          ...this.state,
          phase: "idle",
          socketStatus: "disconnected",
          error: "Missing persisted Telegram session",
          updatedAt: Date.now(),
        });
        return { ok: false, error: "Missing persisted Telegram session" };
      }

      if (snapshot.value !== "ready") {
        return { ok: false, error: "Session is not authenticated" };
      }

      const recoveryState = this.#loadRecoveryState();
      await this.#applySnapshot(snapshot);
      this.setState({
        ...this.state,
        ...recoveryState,
        phase: "authenticated",
        socketStatus: "connecting",
        error: null,
        updatedAt: Date.now(),
      });
      await this.#reconnectAuthenticatedSession(snapshot);
      this.#addActivity({ kind: "connected", label: "Recovered authenticated Telegram session" });

      return { ok: true, ...recoveryState };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.setState({
        ...this.state,
        socketStatus: "error",
        error: msg,
        updatedAt: Date.now(),
      });
      return { ok: false, error: msg };
    }
  }

  // ── Server-side DO RPCs (Worker → Agent, called by worker/index.ts) ────

  async pushFrame(bytes: ArrayBuffer): Promise<void> {
    this.#initSchema();
    const raw = new Uint8Array(bytes);
    this.#addActivity({
      kind: "frame_in",
      label: `\u2190 frame (${raw.length}B)`,
      byteLen: raw.length,
    });

    const snap = this.#loadSnapshot();
    if (!snap) {
      console.warn("[TelegramAgent.pushFrame] no snapshot — instanceId:", this.#instanceId(), "cacheNull:", this.#snapshotCache === null);
      return;
    }

    try {
      const result = await transitionSession(snap, { type: "inbound_frame", frame: raw });
      this.#saveSnapshot(result.snapshot);
      await this.#updateRecoveryFromEvents(result.snapshot, result.events);
      await this.#executeCommands(result.commands);
      await this.#processEvents(snap, result.snapshot, result.events);
      await this.#applySnapshot(result.snapshot);
    } catch (err) {
      console.error("[TelegramAgent.pushFrame] error:", err);
      this.setState({
        ...this.state,
        phase: "error",
        error: err instanceof Error ? err.message : String(err),
        updatedAt: Date.now(),
      });
    }
  }

  async onSocketClosed(code: number, reason: string): Promise<void> {
    this.#initSchema();

    if (this.#manualSocketClose) {
      this.#manualSocketClose = false;
      this.setState({
        ...this.state,
        socketStatus: "disconnected",
        error: null,
        updatedAt: Date.now(),
      });
      return;
    }

    const reconnectCount = (this.#loadRecoveryState().reconnectCount ?? 0) + 1;
    this.#setRecoveryState({ reconnectCount });
    this.#addActivity({
      kind: "disconnected",
      label: `Socket closed (${code}): ${reason}`,
    });

    if (this.state.phase === "authenticated") {
      const snapshot = this.#loadSnapshot();
      if (snapshot) {
        try {
          await this.#reconnectAuthenticatedSession(snapshot);
          this.#addActivity({
            kind: "connected",
            label: `Attempting Telegram reconnect after close (${code})`,
          });
          this.setState({
            ...this.state,
            reconnectCount,
            phase: "authenticated",
            socketStatus: "connecting",
            error: null,
            updatedAt: Date.now(),
          });
          return;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.setState({
            ...this.state,
            reconnectCount,
            phase: "authenticated",
            socketStatus: "error",
            error: message,
            updatedAt: Date.now(),
          });
          return;
        }
      }
    }

    this.setState({
      ...this.state,
      reconnectCount,
      socketStatus: "error",
      phase: this.state.phase === "authenticated" ? "authenticated" : "error",
      error: `Connection closed: ${reason}`,
      updatedAt: Date.now(),
    });
  }

  // ── Process session events (packets, auth state changes) ───────────────

  async #processEvents(
    _prevSnap: SessionSnapshot,
    nextSnap: SessionSnapshot,
    events: SessionEvent[],
  ): Promise<void> {
    const newEntries: ParsedPacketEntry[] = [];

    for (const event of events) {
      const kind = classifyDecryptedFrame(event.object) as ParsedPacketKind;
      const rpc = await parseRpcResultFrame(event.object, {
        requestName: event.requestName,
      }).catch(() => null);

      // Build human-readable summary
      let summary: string;
      if (kind === "rpc_result") {
        summary = rpc?.error
          ? `${rpc.requestName ?? "RPC"} failed: ${rpc.error.message}`
          : rpc?.requestName === "updates.GetDifference"
            ? "updates.GetDifference catch-up result"
            : `${rpc?.requestName ?? "RPC"} result`;
      } else if (kind === "update") {
        summary = getTlObjectClassName(event.object) || "Update";
      } else if (kind === "service") {
        summary = getTlObjectClassName(event.object) || "Service frame";
      } else {
        summary = "Unknown frame";
      }

      const entry: ParsedPacketEntry = {
        id: `frame:${event.msgId}:${event.seqNo}`,
        msgId: event.msgId,
        seqNo: event.seqNo,
        receivedAt: Date.now(),
        kind,
        topLevelClassName: getTlObjectClassName(event.object) ?? undefined,
        reqMsgId: rpc?.reqMsgId ?? undefined,
        requestName: rpc?.requestName ?? event.requestName ?? undefined,
        resultClassName: rpc?.resultClassName ?? undefined,
        error: rpc?.error?.message ?? undefined,
        summary,
        payload: rpc?.normalizedResult ?? normalizeTlValue(event.object),
      };

      newEntries.push(entry);

      // Add activity label
      const label = rpc
        ? rpc.error
          ? `\u2717 ${rpc.requestName ?? "RPC"} failed`
          : `\u2713 ${rpc.requestName ?? "RPC"}`
        : getTlObjectClassName(event.object) || kind;
      this.#addActivity({ kind: "frame_in", label: `\u27F5 ${label}` });
    }

    if (newEntries.length > 0) {
      // Persist to SQL (full history)
      this.#persistPackets(newEntries);

      // Merge into broadcast state (keep last 50)
      const updated = [...this.state.parsedPackets, ...newEntries]
        .slice(-TelegramAgent.#PACKET_STATE_LIMIT);
      this.setState({ ...this.state, parsedPackets: updated, updatedAt: Date.now() });
    }

    if (nextSnap.value === "ready") {
      this.setState({ ...this.state, socketStatus: "connected", updatedAt: Date.now() });
    }
  }

  // ── @callable: fetch full packet history from SQL ───────────────────────

  @callable()
  getFullPacketLog(): ParsedPacketEntry[] {
    return this.#loadPacketsFromSql();
  }
}
