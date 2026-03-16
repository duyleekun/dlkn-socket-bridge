/**
 * ZaloAgent — Durable Object agent for Zalo messaging via zca-js-statemachine.
 *
 * Lifecycle:
 *   1. Client connects via WebSocket (Agent SDK handles that).
 *   2. Client calls initiateQRLogin() → HTTP QR flow via zca-js → bridge socket created.
 *   3. Bridge POSTs inbound frames to /cb/:callbackKey → pushFrame() → state machine.
 *   4. Auto-reconnect on socket close when authenticated.
 */
import { unstable_callable as callable, type Connection } from "agents";
import { ThreadType } from "zca-js";
import {
  sessionRuntimeAdapter as zaloRuntime,
  buildPingFrame,
  buildOldMessagesFrame,
  buildZaloWsHeaders,
  extractSocketMessages,
  type CreateSessionInput,
  type SessionCommand,
  type SessionEvent,
  type SessionHostEvent,
  type SessionSnapshot,
  type SessionStateValue,
  type SessionView,
  type ZaloSessionCommand,
  type ZaloSessionEvent,
  type ZaloSessionHostEvent,
  type ZaloSessionTransitionResult,
  type ZaloCredentials,
  type ZaloUserProfile,
  type ExtractedSocketMessage,
  type SocketFrameEvent,
} from "zca-js-statemachine";
import {
  performQRLogin,
  loginWithCredentials,
  resolveSelfThreadId,
  validatePersistedSession,
  type QRLoginResult,
} from "./zalo/zalo-login";
import {
  getStatus as getBridgeSessionStatus,
  sendBytes,
} from "./shared/bridge-client";
import {
  StateMachineBridgeAgent,
  type BridgeConnectionInfo,
} from "./shared/base-agent";
import type {
  Env,
  ZaloState,
  ZaloPhase,
  SocketActivity,
  BridgeStatusResponse,
} from "./shared/types";
import { DEFAULT_ZALO_STATE } from "./shared/types";

// ── SQL table names ──────────────────────────────────────────────────────────
const SQL_INIT = `
CREATE TABLE IF NOT EXISTS zalo_session (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS zalo_messages (
  msg_id      TEXT PRIMARY KEY,
  thread_id   TEXT NOT NULL,
  thread_type INTEGER,
  thread_name TEXT NOT NULL DEFAULT '',
  sender_uid  TEXT NOT NULL DEFAULT '',
  sender_name TEXT NOT NULL DEFAULT '',
  content     TEXT NOT NULL DEFAULT '',
  ts          INTEGER NOT NULL DEFAULT 0,
  outgoing    INTEGER NOT NULL DEFAULT 0
);
`;

function mapPhase(smValue: string): ZaloPhase {
  switch (smValue) {
    case "idle":
      return "idle";
    case "qr_connecting":
    case "qr_awaiting_scan":
      return "qr_pending";
    case "qr_scanned":
      return "qr_scanned";
    case "cred_logging_in":
      return "authenticating";
    case "ws_connecting":
    case "logged_in":
      return "recovering";
    case "listening":
      return "authenticated";
    case "reconnecting":
      return "recovering";
    case "error":
    case "qr_expired":
      return "error";
    default:
      return "idle";
  }
}

function deriveRestoredState(
  snapshot: SessionSnapshot | null,
  hasCredentials: boolean,
  hasUserProfile: boolean,
): Pick<ZaloState, "phase" | "socketStatus"> {
  if (!snapshot) {
    if (hasCredentials && hasUserProfile) {
      return {
        phase: "recovering",
        socketStatus: "connecting",
      };
    }
    return {
      phase: "idle",
      socketStatus: "disconnected",
    };
  }

  const phase = mapPhase(snapshot.value);
  if (hasCredentials && hasUserProfile && phase === "authenticating") {
    return {
      phase: "recovering",
      socketStatus: "connecting",
    };
  }

  return {
    phase,
    socketStatus:
      phase === "authenticated"
        ? "connected"
        : phase === "recovering" || phase === "authenticating"
          ? "connecting"
          : phase === "error"
            ? "error"
            : "disconnected",
  };
}

function toBroadcastUserProfile(
  userProfile: ZaloUserProfile | null,
): ZaloState["userProfile"] {
  if (!userProfile) {
    return null;
  }
  return {
    uid: userProfile.uid,
    displayName: userProfile.displayName,
    avatar: userProfile.avatar,
  };
}

// ── ZaloAgent ────────────────────────────────────────────────────────────────

export class ZaloAgent extends StateMachineBridgeAgent<
  ZaloState,
  CreateSessionInput,
  SessionHostEvent,
  SessionSnapshot,
  SessionStateValue,
  SessionCommand,
  SessionEvent,
  SessionView
> {
  initialState = DEFAULT_ZALO_STATE;
  protected readonly platform = "zalo" as const;
  protected readonly runtimeAdapter = zaloRuntime;
  protected override activityStateLimit = 50;

  // Internal mutable state (not broadcast — persisted in SQL)
  private snapshot: SessionSnapshot | null = null;
  private bridgeSocketId: string | null = null;
  private callbackKey: string | null = null;
  private credentials: ZaloCredentials | null = null;
  private userProfile: ZaloUserProfile | null = null;
  private wsUrl: string | null = null;
  private pingIntervalMs = 20_000;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private sqlInitialized = false;
  private lastEventSeq = 0;
  private lastEventAt: number | null = null;
  private reconnectCount = 0;
  private lastUserMessageId: string | null = null;
  private lastUserMessageTs: number | null = null;
  private lastGroupMessageId: string | null = null;
  private lastGroupMessageTs: number | null = null;

  // ── Lifecycle ────────────────────────────────────────────────────────────

  async onStart(): Promise<void> {
    this.ensureSql();
    await this.loadPersistedState();
  }

  onConnect(connection: Connection, _ctx: ConnectionContext): void {
    // Send current state to newly connected client
    connection.send(JSON.stringify(this.state));
  }

  protected override normalizeState(nextState: ZaloState): ZaloState {
    const normalized: ZaloState = {
      ...nextState,
      userProfile:
        nextState.userProfile ??
        toBroadcastUserProfile(this.userProfile),
    };

    if (
      normalized.socketStatus === "connected" &&
      this.credentials &&
      this.userProfile &&
      (normalized.phase === "authenticating" ||
        normalized.phase === "recovering")
    ) {
      normalized.phase = "authenticated";
    }

    return normalized;
  }

  // ── SQL helpers ──────────────────────────────────────────────────────────

  private ensureSql(): void {
    if (this.sqlInitialized) return;
    this.sql`CREATE TABLE IF NOT EXISTS zalo_session (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS zalo_messages (
      msg_id      TEXT PRIMARY KEY,
      thread_id   TEXT NOT NULL,
      thread_type INTEGER,
      thread_name TEXT NOT NULL DEFAULT '',
      sender_uid  TEXT NOT NULL DEFAULT '',
      sender_name TEXT NOT NULL DEFAULT '',
      content     TEXT NOT NULL DEFAULT '',
      ts          INTEGER NOT NULL DEFAULT 0,
      outgoing    INTEGER NOT NULL DEFAULT 0
    )`;
    this.ensureThreadTypeColumn();
    this.sql`CREATE TABLE IF NOT EXISTS zalo_activity (
      id     TEXT PRIMARY KEY,
      kind   TEXT NOT NULL,
      label  TEXT NOT NULL,
      byte_len INTEGER,
      ts     INTEGER NOT NULL
    )`;
    this.sqlInitialized = true;
  }

  private ensureThreadTypeColumn(): void {
    const columns = this.sql<{ name: string }>`PRAGMA table_info(zalo_messages)`;
    if (columns.some((column) => column.name === "thread_type")) {
      return;
    }
    this.sql`ALTER TABLE zalo_messages ADD COLUMN thread_type INTEGER`;
  }

  // ── Activity log SQL persistence ─────────────────────────────────────────

  private static readonly ACTIVITY_SQL_LIMIT = 500;

  private persistActivity(entry: SocketActivity): void {
    this.sql`
      INSERT OR IGNORE INTO zalo_activity (id, kind, label, byte_len, ts)
      VALUES (${entry.id}, ${entry.kind}, ${entry.label}, ${entry.byteLen ?? null}, ${entry.ts})
    `;
    // Prune old rows
    this.sql`
      DELETE FROM zalo_activity WHERE id NOT IN (
        SELECT id FROM zalo_activity ORDER BY ts DESC LIMIT ${ZaloAgent.ACTIVITY_SQL_LIMIT}
      )
    `;
  }

  @callable()
  getFullSocketActivity(limit = ZaloAgent.ACTIVITY_SQL_LIMIT): SocketActivity[] {
    return this.sql<{ id: string; kind: string; label: string; byte_len: number | null; ts: number }>`
      SELECT id, kind, label, byte_len, ts
      FROM zalo_activity
      ORDER BY ts ASC
      LIMIT ${limit}
    `.map((r) => ({
      id: r.id,
      kind: r.kind as SocketActivity["kind"],
      label: r.label,
      byteLen: r.byte_len ?? undefined,
      ts: r.ts,
    }));
  }

  protected override kvGet(key: string): string | null {
    const rows = this.sql<{ value: string }>`
      SELECT value FROM zalo_session WHERE key = ${key}
    `;
    return rows.length > 0 ? rows[0].value : null;
  }

  protected override kvSet(key: string, value: string): void {
    this.sql`
      INSERT OR REPLACE INTO zalo_session (key, value) VALUES (${key}, ${value})
    `;
  }

  protected override kvDel(key: string): void {
    this.sql`DELETE FROM zalo_session WHERE key = ${key}`;
  }

  private persistRecoveryState(): void {
    this.kvSet("last_event_seq", String(this.lastEventSeq));
    this.kvSet("reconnect_count", String(this.reconnectCount));
    if (this.lastEventAt == null) {
      this.kvDel("last_event_at");
      return;
    }
    this.kvSet("last_event_at", String(this.lastEventAt));
  }

  private persistMessageCursor(): void {
    if (this.lastUserMessageId) {
      this.kvSet("last_user_message_id", this.lastUserMessageId);
    } else {
      this.kvDel("last_user_message_id");
    }

    if (this.lastUserMessageTs != null) {
      this.kvSet("last_user_message_ts", String(this.lastUserMessageTs));
    } else {
      this.kvDel("last_user_message_ts");
    }

    if (this.lastGroupMessageId) {
      this.kvSet("last_group_message_id", this.lastGroupMessageId);
    } else {
      this.kvDel("last_group_message_id");
    }

    if (this.lastGroupMessageTs != null) {
      this.kvSet("last_group_message_ts", String(this.lastGroupMessageTs));
    } else {
      this.kvDel("last_group_message_ts");
    }
  }

  private syncRecoveryState(updatedAt = Date.now()): void {
    this.patchState({
      lastEventSeq: this.lastEventSeq,
      lastEventAt: this.lastEventAt,
      reconnectCount: this.reconnectCount,
    }, updatedAt);
  }

  private trackProcessedMessages(msgs: ExtractedSocketMessage[]): void {
    if (msgs.length === 0) return;
    const now = Date.now();
    this.lastEventSeq += msgs.length;
    this.lastEventAt = now;
    this.persistRecoveryState();

    for (const msg of msgs) {
      if (!msg.id || msg.id === "0") continue;
      if (msg.isGroup) {
        if ((this.lastGroupMessageTs ?? 0) <= msg.timestamp) {
          this.lastGroupMessageId = msg.id;
          this.lastGroupMessageTs = msg.timestamp;
        }
      } else if ((this.lastUserMessageTs ?? 0) <= msg.timestamp) {
        this.lastUserMessageId = msg.id;
        this.lastUserMessageTs = msg.timestamp;
      }
    }

    this.persistMessageCursor();
    this.syncRecoveryState(now);
  }

  private resolveCursorFromStoredMessages(): void {
    if (this.lastUserMessageId && this.lastGroupMessageId) {
      return;
    }

    const rows = this.sql<{
      msg_id: string;
      thread_type: number | null;
      ts: number;
    }>`
      SELECT msg_id, thread_type, ts
      FROM zalo_messages
      WHERE msg_id != '0' AND thread_type IS NOT NULL
      ORDER BY ts ASC
    `;

    let changed = false;
    for (const row of rows) {
      if (row.thread_type === 1) {
        if (
          !this.lastGroupMessageId ||
          row.ts >= (this.lastGroupMessageTs ?? 0)
        ) {
          this.lastGroupMessageId = row.msg_id;
          this.lastGroupMessageTs = row.ts;
          changed = true;
        }
        continue;
      }

      if (
        !this.lastUserMessageId ||
        row.ts >= (this.lastUserMessageTs ?? 0)
      ) {
        this.lastUserMessageId = row.msg_id;
        this.lastUserMessageTs = row.ts;
        changed = true;
      }
    }

    if (changed) {
      this.persistMessageCursor();
    }
  }

  private markReconnect(): void {
    this.reconnectCount += 1;
    this.persistRecoveryState();
    this.syncRecoveryState();
  }

  // ── Persistence ──────────────────────────────────────────────────────────

  private async loadPersistedState(): Promise<void> {
    const snapshotRaw = this.kvGet("snapshot");
    if (snapshotRaw) {
      try {
        this.snapshot = JSON.parse(snapshotRaw) as SessionSnapshot;
      } catch {
        this.snapshot = null;
      }
    }

    const credsRaw = this.kvGet("credentials");
    if (credsRaw) {
      try {
        this.credentials = JSON.parse(credsRaw) as ZaloCredentials;
      } catch {
        this.credentials = null;
      }
    }

    const profileRaw = this.kvGet("user_profile");
    if (profileRaw) {
      try {
        this.userProfile = JSON.parse(profileRaw) as ZaloUserProfile;
      } catch {
        this.userProfile = null;
      }
    }

    const wsUrlRaw = this.kvGet("ws_url");
    if (wsUrlRaw) this.wsUrl = wsUrlRaw;

    const pingRaw = this.kvGet("ping_interval_ms");
    if (pingRaw) this.pingIntervalMs = parseInt(pingRaw, 10) || 20_000;

    const bridge = this.loadBridgeInfo();
    if (bridge) {
      this.bridgeSocketId = bridge.socketId;
      this.callbackKey = bridge.callbackKey;
    }

    const seqRaw = this.kvGet("last_event_seq");
    this.lastEventSeq = seqRaw ? Number(seqRaw) || 0 : 0;

    const atRaw = this.kvGet("last_event_at");
    this.lastEventAt = atRaw ? Number(atRaw) || null : null;

    const reconnectRaw = this.kvGet("reconnect_count");
    this.reconnectCount = reconnectRaw ? Number(reconnectRaw) || 0 : 0;
    this.lastUserMessageId = this.kvGet("last_user_message_id");
    const lastUserTsRaw = this.kvGet("last_user_message_ts");
    this.lastUserMessageTs = lastUserTsRaw ? Number(lastUserTsRaw) || null : null;
    this.lastGroupMessageId = this.kvGet("last_group_message_id");
    const lastGroupTsRaw = this.kvGet("last_group_message_ts");
    this.lastGroupMessageTs = lastGroupTsRaw ? Number(lastGroupTsRaw) || null : null;
    this.resolveCursorFromStoredMessages();

    // Rebuild broadcast state from persisted data
    const nextState: ZaloState = {
      ...this.state,
      lastEventSeq: this.lastEventSeq,
      lastEventAt: this.lastEventAt,
      reconnectCount: this.reconnectCount,
    };
    if (this.snapshot) {
      const restored = deriveRestoredState(
        this.snapshot,
        this.credentials != null,
        this.userProfile != null,
      );
      this.replaceState({
        ...nextState,
        phase: restored.phase,
        userProfile: toBroadcastUserProfile(this.userProfile),
        socketStatus: restored.socketStatus,
        updatedAt: Date.now(),
      });
      return;
    }

    this.replaceState({
      ...nextState,
      updatedAt: Date.now(),
    });
  }

  private persistSnapshot(): void {
    if (this.snapshot) {
      this.kvSet("snapshot", JSON.stringify(this.snapshot));
    }
  }

  private persistCredentials(
    creds: ZaloCredentials,
    profile: ZaloUserProfile,
    wsUrl: string,
    pingIntervalMs: number,
  ): void {
    this.credentials = creds;
    this.userProfile = profile;
    this.wsUrl = wsUrl;
    this.pingIntervalMs = pingIntervalMs;
    this.kvSet("credentials", JSON.stringify(creds));
    this.kvSet("user_profile", JSON.stringify(profile));
    this.kvSet("ws_url", wsUrl);
    this.kvSet("ping_interval_ms", String(pingIntervalMs));
  }

  private clearPersistedCredentials(): void {
    this.credentials = null;
    this.userProfile = null;
    this.wsUrl = null;
    this.lastEventSeq = 0;
    this.lastEventAt = null;
    this.reconnectCount = 0;
    this.lastUserMessageId = null;
    this.lastUserMessageTs = null;
    this.lastGroupMessageId = null;
    this.lastGroupMessageTs = null;
    for (const key of [
      "credentials",
      "user_profile",
      "ws_url",
      "snapshot",
      "last_event_seq",
      "last_event_at",
      "reconnect_count",
      "last_user_message_id",
      "last_user_message_ts",
      "last_group_message_id",
      "last_group_message_ts",
    ]) {
      this.kvDel(key);
    }
    this.clearBridgeInfo();
  }

  protected override saveBridgeInfo(info: BridgeConnectionInfo): void {
    super.saveBridgeInfo(info);
    this.bridgeSocketId = info.socketId;
    this.callbackKey = info.callbackKey;
  }

  protected override clearBridgeInfo(): void {
    super.clearBridgeInfo();
    this.bridgeSocketId = null;
    this.callbackKey = null;
  }

  protected override onActivity(entry: SocketActivity): void {
    this.persistActivity(entry);
  }

  // ── Bridge socket management ─────────────────────────────────────────────

  private async createBridgeSocket(
    wsUrl: string,
  headers?: Record<string, string>,
  ): Promise<{ socketId: string; callbackKey: string }> {
    const bridge = await this.createBridgeConnection(wsUrl, {
      headers,
    });
    return { socketId: bridge.socketId, callbackKey: bridge.callbackKey };
  }

  private async closeBridgeSocket(): Promise<void> {
    try {
      await this.closeBridgeConnection();
    } catch (err) {
      console.warn("[ZaloAgent] closeBridgeSocket error:", err);
    }
  }

  private async sendToBridge(data: Uint8Array): Promise<void> {
    const bridge = this.loadBridgeInfo();
    if (!bridge) {
      throw new Error("No active bridge socket");
    }
    await sendBytes(bridge.bridgeUrl, bridge.socketId, data);
    this.addActivity({
      kind: "frame_out",
      label: `Outbound frame (${data.byteLength}B)`,
      byteLen: data.byteLength,
    });
  }

  // ── Ping management ──────────────────────────────────────────────────────

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(async () => {
      try {
        const pingFrame = buildPingFrame();
        await this.sendToBridge(pingFrame);
      } catch (err) {
        console.warn("[ZaloAgent] ping error:", err);
      }
    }, this.pingIntervalMs);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  // ── State machine execution ──────────────────────────────────────────────

  private async executeCommands(
    commands: ZaloSessionCommand[],
  ): Promise<void> {
    for (const cmd of commands) {
      console.log(
        "[ZaloAgent] executeCommands",
        JSON.stringify({
          type: cmd.type,
          hasBridge: this.loadBridgeInfo() != null,
          hasCredentials: this.credentials != null,
          phase: this.state.phase,
        }),
      );

      switch (cmd.type) {
        case "send_ping": {
          try {
            const pingFrame = buildPingFrame();
            await this.sendToBridge(pingFrame);
          } catch (err) {
            console.warn("[ZaloAgent] send_ping error:", err);
          }
          break;
        }

        case "request_old_messages": {
          try {
            const frame = buildOldMessagesFrame(
              cmd.threadType,
              cmd.lastMessageId,
            );
            await this.sendToBridge(frame);
          } catch (err) {
            console.warn("[ZaloAgent] request_old_messages error:", err);
          }
          break;
        }

        case "reconnect": {
          // Close old socket, create new one
          console.log(
            "[ZaloAgent] reconnect command",
            JSON.stringify({
              wsUrl: cmd.wsUrl,
              hasHeaders: Boolean(cmd.headers && Object.keys(cmd.headers).length > 0),
            }),
          );
          await this.closeBridgeSocket();
          const headers =
            cmd.headers ??
            (this.credentials
              ? buildZaloWsHeaders(this.credentials, cmd.wsUrl)
              : undefined);
          await this.createBridgeSocket(cmd.wsUrl, headers);
          this.addActivity({
            kind: "connected",
            label: `Reconnecting to ${cmd.wsUrl}`,
          });
          break;
        }

        case "persist_credentials": {
          if (cmd.credentials && cmd.userProfile) {
            this.persistCredentials(
              cmd.credentials,
              cmd.userProfile,
              cmd.wsUrl,
              cmd.pingIntervalMs,
            );
          }
          break;
        }

        case "clear_credentials": {
          this.clearPersistedCredentials();
          break;
        }

        case "http_login_qr":
        case "http_login_creds":
          // Handled externally by initiateQRLogin / submitCredentials
          break;

        default: {
          const _exhaustive: never = cmd;
          void _exhaustive;
        }
      }
    }
  }

  private processEvents(events: ZaloSessionEvent[]): void {
    for (const event of events) {
      switch (event.type) {
        case "qr_ready":
          this.patchState({
            phase: "qr_pending",
            qrCode: event.qrImage,
            qrExpiresAt: event.expiresAt,
            error: null,
          });
          break;

        case "qr_scanned":
          this.patchState({
            phase: "qr_scanned",
          });
          break;

        case "login_success":
          this.patchState({
            phase: "recovering",
            qrCode: null,
            qrExpiresAt: null,
            userProfile: toBroadcastUserProfile(event.userProfile),
            socketStatus: "connecting",
            error: null,
          });
          break;

        default: {
          // SocketFrameEvent — extract messages
          if ("cmd" in event && "subCmd" in event) {
            const frameEvent = event as unknown as SocketFrameEvent;
            const msgs = extractSocketMessages(frameEvent);
            if (msgs.length > 0) {
              this.storeMessages(msgs);
              this.trackProcessedMessages(msgs);
              this.updateRecentMessages(msgs);
            }
            if (
              this.credentials &&
              this.userProfile &&
              this.state.phase !== "authenticated"
            ) {
              this.patchState({
                phase: "authenticated",
                socketStatus: "connected",
                error: null,
              });
            }
          }
          break;
        }
      }
    }
  }

  private async applyTransition(
    result: ZaloSessionTransitionResult,
  ): Promise<void> {
    this.snapshot = result.snapshot;
    this.persistSnapshot();

    const phase = mapPhase(result.snapshot.value);

    // Update socket status
    let socketStatus = this.state.socketStatus;
    if (phase === "authenticated") {
      socketStatus = "connected";
      this.startPing();
    } else if (phase === "recovering") {
      socketStatus = "connecting";
    } else if (phase === "error") {
      socketStatus = "error";
      this.stopPing();
    }

    this.patchState({
      phase,
      socketStatus,
      error:
        phase === "error"
          ? result.snapshot.context.errorMessage ?? "Unknown error"
          : null,
    });

    // Execute commands first (may create bridge sockets etc.)
    await this.executeCommands(result.commands);

    // Process events (broadcasts to clients)
    this.processEvents(result.events);
  }

  // ── Message storage ──────────────────────────────────────────────────────

  private storeMessages(msgs: ExtractedSocketMessage[]): void {
    for (const msg of msgs) {
      this.sql`
        INSERT OR IGNORE INTO zalo_messages (msg_id, thread_id, thread_type, sender_uid, content, ts, outgoing)
        VALUES (${msg.id}, ${msg.fromId}, ${msg.isGroup ? 1 : 0}, ${msg.fromId}, ${msg.content}, ${msg.timestamp}, ${0})
      `;
    }
  }

  private updateRecentMessages(msgs: ExtractedSocketMessage[]): void {
    const recent = [...this.state.recentMessages];
    for (const msg of msgs) {
      recent.push({
        msgId: msg.id,
        threadId: msg.fromId,
        senderName: msg.fromId,
        content: msg.content,
        ts: msg.timestamp,
        outgoing: false,
      });
    }
    // Keep last 50
    const trimmed = recent.length > 50 ? recent.slice(-50) : recent;
    this.patchState({
      recentMessages: trimmed,
    });
  }

  private recordOutgoingMessage(input: {
    messageId: string;
    threadId: string;
    content: string;
    threadType: number;
  }): void {
    const ts = Date.now();
    this.sql`
      INSERT OR REPLACE INTO zalo_messages (msg_id, thread_id, thread_type, sender_uid, content, ts, outgoing)
      VALUES (${input.messageId}, ${input.threadId}, ${input.threadType}, ${this.userProfile?.uid ?? input.threadId}, ${input.content}, ${ts}, ${1})
    `;

    const recent = [
      ...this.state.recentMessages,
      {
        msgId: input.messageId,
        threadId: input.threadId,
        senderName: this.userProfile?.displayName ?? "You",
        content: input.content,
        ts,
        outgoing: true,
      },
    ];

    this.patchState({
      recentMessages: recent.length > 50 ? recent.slice(-50) : recent,
    }, ts);

    if (input.threadType === ThreadType.Group) {
      this.lastGroupMessageId = input.messageId;
      this.lastGroupMessageTs = ts;
    } else {
      this.lastUserMessageId = input.messageId;
      this.lastUserMessageTs = ts;
    }
    this.persistMessageCursor();
  }

  // ── Activity log ─────────────────────────────────────────────────────────

  protected override addActivity(
    activity: Omit<SocketActivity, "id" | "ts">,
    limit?: number,
  ): SocketActivity {
    return super.addActivity(activity, limit);
  }

  // ── @callable() RPC methods ──────────────────────────────────────────────

  /**
   * Initiate QR-code login via zca-js HTTP flow.
   * The QR image and scan events are broadcast to connected clients via setState.
   */
  @callable()
  async initiateQRLogin(input: {
    requestOrigin: string;
  }): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      this.ensureSql();
      this.resolveRequestOrigin(input.requestOrigin);
      this.lastEventSeq = 0;
      this.lastEventAt = null;
      this.reconnectCount = 0;
      this.lastUserMessageId = null;
      this.lastUserMessageTs = null;
      this.lastGroupMessageId = null;
      this.lastGroupMessageTs = null;
      this.persistRecoveryState();
      this.persistMessageCursor();
      this.syncRecoveryState();

      // 1. Create initial state machine session
      const initResult = await this.createMachineSession({
        mode: "qr",
        userAgent: "Mozilla/5.0",
        language: "vi",
      });
      this.snapshot = initResult.snapshot;
      this.persistSnapshot();

      this.setState({
        ...this.state,
        phase: "qr_pending",
        error: null,
        socketStatus: "disconnected",
        updatedAt: Date.now(),
      });

      // 2. Perform QR login (async HTTP flow — blocks until complete or error)
      const loginResult: QRLoginResult = await performQRLogin(
        "Mozilla/5.0",
        "vi",
        // onQrReady
        async (qrImage: string) => {
          // Transition state machine with QR data
          if (this.snapshot) {
            const result = await this.transitionMachineSession(this.snapshot, {
              type: "http_login_qr_result",
              qrData: {
                image: qrImage,
                token: crypto.randomUUID(),
                expiresAt: Date.now() + 120_000,
              },
            });
            await this.applyTransition(result);
          } else {
            // Fallback: directly update state
            this.setState({
              ...this.state,
              phase: "qr_pending",
              qrCode: qrImage,
              qrExpiresAt: Date.now() + 120_000,
              updatedAt: Date.now(),
            });
          }
        },
        // onScanned
        async (info) => {
          if (this.snapshot) {
            const result = await this.transitionMachineSession(this.snapshot, {
              type: "qr_scan_event",
              event: "scanned",
              data: info,
            });
            await this.applyTransition(result);
          } else {
            this.setState({
              ...this.state,
              phase: "qr_scanned",
              updatedAt: Date.now(),
            });
          }
        },
      );

      // 3. Login succeeded — transition state machine with credentials
      if (this.snapshot) {
        const result = await this.transitionMachineSession(this.snapshot, {
          type: "http_login_creds_result",
          credentials: loginResult.credentials,
          userProfile: loginResult.userProfile,
          wsUrl: loginResult.wsUrl,
          pingIntervalMs: loginResult.pingIntervalMs,
        });

        // The transition generates reconnect + persist_credentials commands
        await this.applyTransition(result);
      }

      return { ok: true };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error("[ZaloAgent] initiateQRLogin failed:", errorMsg);

      if (this.snapshot) {
        const result = await this.transitionMachineSession(this.snapshot, {
          type: "http_login_failed",
          errorMessage: errorMsg,
        });
        await this.applyTransition(result);
      } else {
        this.setState({
          ...this.state,
          phase: "error",
          error: errorMsg,
          updatedAt: Date.now(),
        });
      }

      return { ok: false, error: errorMsg };
    }
  }

  /**
   * Credentials-based login (imei + cookie + userAgent).
   */
  @callable()
  async submitCredentials(input: {
    imei: string;
    cookie: Array<{ key: string; value: string; domain?: string; path?: string }>;
    userAgent: string;
    language?: string;
  }): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      this.ensureSql();
      this.lastEventSeq = 0;
      this.lastEventAt = null;
      this.reconnectCount = 0;
      this.lastUserMessageId = null;
      this.lastUserMessageTs = null;
      this.lastGroupMessageId = null;
      this.lastGroupMessageTs = null;
      this.persistRecoveryState();
      this.persistMessageCursor();
      this.syncRecoveryState();

      const credentials: ZaloCredentials = {
        imei: input.imei,
        cookie: input.cookie,
        userAgent: input.userAgent,
        language: input.language ?? "vi",
      };

      // Create state machine in credentials mode
      const initResult = await this.createMachineSession({
        mode: "credentials",
        credentials,
        userAgent: input.userAgent,
        language: input.language ?? "vi",
      });
      this.snapshot = initResult.snapshot;
      this.persistSnapshot();

      this.setState({
        ...this.state,
        phase: "authenticating",
        socketStatus: "connecting",
        error: null,
        updatedAt: Date.now(),
      });

      // Validate credentials via HTTP
      const validationResult = await validatePersistedSession({
        credentials,
        userProfile: null,
      });

      if (!validationResult.ok) {
        if (this.snapshot) {
          const result = await this.transitionMachineSession(this.snapshot, {
            type: "http_login_failed",
            errorMessage: validationResult.error,
          });
          await this.applyTransition(result);
        }
        return { ok: false, error: validationResult.error };
      }

      // Transition with login result
      if (this.snapshot) {
        const result = await this.transitionMachineSession(this.snapshot, {
          type: "http_login_creds_result",
          credentials: validationResult.credentials,
          userProfile: validationResult.userProfile,
          wsUrl: validationResult.wsUrl,
          pingIntervalMs: validationResult.pingIntervalMs,
        });
        await this.applyTransition(result);
      }

      return { ok: true };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error("[ZaloAgent] submitCredentials failed:", errorMsg);
      this.setState({
        ...this.state,
        phase: "error",
        error: errorMsg,
        updatedAt: Date.now(),
      });
      return { ok: false, error: errorMsg };
    }
  }

  /**
   * Recover session from persisted credentials (auto-reconnect on DO wake).
   */
  @callable()
  async recoverSession(input?: {
    requestOrigin?: string;
  }): Promise<
    {
      ok: true;
      lastEventSeq: number;
      lastEventAt: number | null;
      reconnectCount: number;
    } | { ok: false; error: string }
  > {
    try {
      this.ensureSql();
      this.resolveRequestOrigin(input?.requestOrigin);

      if (!this.credentials || !this.wsUrl) {
        return { ok: false, error: "No persisted credentials" };
      }

      this.setState({
        ...this.state,
        phase: "recovering",
        socketStatus: "connecting",
        error: null,
        updatedAt: Date.now(),
      });

      // Validate persisted session
      const validationResult = await validatePersistedSession({
        credentials: this.credentials,
        userProfile: this.userProfile,
      });

      if (!validationResult.ok) {
        this.setState({
          ...this.state,
          phase: "error",
          socketStatus: "error",
          error: validationResult.error,
          updatedAt: Date.now(),
        });
        return { ok: false, error: validationResult.error };
      }

      // Update persisted creds (cookie may have been refreshed)
      this.persistCredentials(
        validationResult.credentials,
        validationResult.userProfile,
        validationResult.wsUrl,
        validationResult.pingIntervalMs,
      );

      // Prepare the new state-machine snapshot before any bridge frames arrive.
      const initResult = await this.createMachineSession({
        mode: "credentials",
        credentials: validationResult.credentials,
        userAgent: validationResult.credentials.userAgent,
        language: validationResult.credentials.language ?? "vi",
      });

      // Transition to ws_connecting with the login result
      const result = await this.transitionMachineSession(initResult.snapshot, {
        type: "http_login_creds_result",
        credentials: validationResult.credentials,
        userProfile: validationResult.userProfile,
        wsUrl: validationResult.wsUrl,
        pingIntervalMs: validationResult.pingIntervalMs,
      });

      this.snapshot = result.snapshot;
      this.persistSnapshot();

      const headers = buildZaloWsHeaders(
        validationResult.credentials,
        validationResult.wsUrl,
      );
      await this.closeBridgeSocket();
      await this.createBridgeSocket(validationResult.wsUrl, headers);
      await this.sendToBridge(buildPingFrame());

      // Don't execute commands here — the bridge socket was already created above.
      // The synthetic login_success event reflects the pre-listening snapshot, so
      // replaying it during recovery would bounce the UI back to "authenticating".
      this.processEvents(
        result.events.filter((event) => event.type !== "login_success"),
      );

      this.addActivity({
        kind: "connected",
        label: "Session recovered from persisted credentials",
      });
      this.startPing();
      this.setState({
        ...this.state,
        phase: "authenticated",
        socketStatus: "connected",
        userProfile: validationResult.userProfile
          ? {
              uid: validationResult.userProfile.uid,
              displayName: validationResult.userProfile.displayName,
              avatar: validationResult.userProfile.avatar,
            }
          : null,
        error: null,
        updatedAt: Date.now(),
      });

      return {
        ok: true,
        lastEventSeq: this.lastEventSeq,
        lastEventAt: this.lastEventAt,
        reconnectCount: this.reconnectCount,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error("[ZaloAgent] recoverSession failed:", errorMsg);
      this.setState({
        ...this.state,
        phase: "error",
        socketStatus: "error",
        error: errorMsg,
        updatedAt: Date.now(),
      });
      return { ok: false, error: errorMsg };
    }
  }

  @callable()
  getRecoveryState(): {
    lastEventSeq: number;
    lastEventAt: number | null;
    reconnectCount: number;
    phase: ZaloPhase;
    socketStatus: ZaloState["socketStatus"];
    hasPersistedCredentials: boolean;
    hasActiveBridge: boolean;
    lastUserMessageId: string | null;
    lastUserMessageTs: number | null;
    lastGroupMessageId: string | null;
    lastGroupMessageTs: number | null;
  } {
    this.resolveCursorFromStoredMessages();
    return {
      lastEventSeq: this.lastEventSeq,
      lastEventAt: this.lastEventAt,
      reconnectCount: this.reconnectCount,
      phase: this.state.phase,
      socketStatus: this.state.socketStatus,
      hasPersistedCredentials: this.credentials != null,
      hasActiveBridge: this.loadBridgeInfo() != null,
      lastUserMessageId: this.lastUserMessageId,
      lastUserMessageTs: this.lastUserMessageTs,
      lastGroupMessageId: this.lastGroupMessageId,
      lastGroupMessageTs: this.lastGroupMessageTs,
    };
  }

  @callable()
  async getBridgeStatus(): Promise<
    { ok: true; status: BridgeStatusResponse }
    | { ok: false; error: string }
  > {
    const bridge = this.loadBridgeInfo();
    if (!bridge) {
      return { ok: false, error: "No active bridge socket" };
    }
    try {
      const status = await getBridgeSessionStatus(
        bridge.bridgeUrl,
        bridge.socketId,
      );
      return { ok: true, status };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  @callable()
  async fetchMissingEvents(): Promise<{
    ok: boolean;
    error?: string;
    requestedDm: boolean;
    requestedGroup: boolean;
  }> {
    this.resolveCursorFromStoredMessages();

    if (!this.bridgeSocketId) {
      return {
        ok: false,
        error: "No active bridge socket",
        requestedDm: false,
        requestedGroup: false,
      };
    }

    const commands: Array<{ threadType: 0 | 1; lastMessageId: string }> = [];
    if (this.lastUserMessageId) {
      commands.push({ threadType: 0, lastMessageId: this.lastUserMessageId });
    }
    if (this.lastGroupMessageId) {
      commands.push({ threadType: 1, lastMessageId: this.lastGroupMessageId });
    }
    if (commands.length === 0) {
      return {
        ok: false,
        error: "No message recovery cursor is available yet",
        requestedDm: false,
        requestedGroup: false,
      };
    }

    try {
      for (const command of commands) {
        await this.sendToBridge(
          buildOldMessagesFrame(command.threadType, command.lastMessageId),
        );
      }
      return {
        ok: true,
        requestedDm: Boolean(this.lastUserMessageId),
        requestedGroup: Boolean(this.lastGroupMessageId),
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        requestedDm: false,
        requestedGroup: false,
      };
    }
  }

  @callable()
  async sendMessage(input: {
    threadId: string;
    threadType: number;
    text: string;
  }): Promise<{ ok: boolean; messageId?: string; error?: string }> {
    const threadId = input.threadId.trim();
    const text = input.text.trim();
    if (!threadId) {
      return { ok: false, error: "Destination thread is required." };
    }
    if (!text) {
      return { ok: false, error: "Message text is required." };
    }
    if (!this.credentials) {
      return { ok: false, error: "No persisted credentials available." };
    }

    try {
      const api = await loginWithCredentials(this.credentials);
      const selfThreadId = resolveSelfThreadId(api);
      const isSelfTarget =
        input.threadType !== ThreadType.Group &&
        threadId === (this.userProfile?.uid ?? "");
      if (isSelfTarget && !selfThreadId) {
        return {
          ok: false,
          error: "Authenticated session did not expose a self-send target.",
        };
      }

      const response = await api.sendMessage(
        text,
        isSelfTarget ? selfThreadId! : threadId,
        input.threadType === ThreadType.Group ? ThreadType.Group : ThreadType.User,
      );
      const messageId =
        response.message?.msgId != null
          ? String(response.message.msgId)
          : `local-${Date.now()}`;
      this.recordOutgoingMessage({
        messageId,
        threadId,
        content: text,
        threadType: input.threadType,
      });
      return { ok: true, messageId };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Logout — close socket, clear state, reset.
   */
  @callable()
  async logout(): Promise<void> {
    this.stopPing();

    if (this.snapshot) {
      try {
        const result = await this.transitionMachineSession(this.snapshot, {
          type: "logout",
        });
        await this.executeCommands(result.commands);
      } catch (err) {
        console.warn("[ZaloAgent] logout transition error:", err);
      }
    }

    await this.closeBridgeSocket();
    this.clearPersistedCredentials();
    this.snapshot = null;

    this.setState({
      ...DEFAULT_ZALO_STATE,
      updatedAt: Date.now(),
    });
  }

  /**
   * Get recent messages from SQL storage.
   */
  @callable()
  async getMessages(opts?: {
    threadId?: string;
    limit?: number;
    offset?: number;
  }): Promise<
    Array<{
      msgId: string;
      threadId: string;
      senderUid: string;
      content: string;
      ts: number;
      outgoing: boolean;
    }>
  > {
    this.ensureSql();
    const limit = opts?.limit ?? 50;
    const offset = opts?.offset ?? 0;

    let rows: Array<{
      msg_id: string;
      thread_id: string;
      sender_uid: string;
      content: string;
      ts: number;
      outgoing: number;
    }>;
    if (opts?.threadId) {
      rows = this.sql<{
        msg_id: string;
        thread_id: string;
        sender_uid: string;
        content: string;
        ts: number;
        outgoing: number;
      }>`SELECT msg_id, thread_id, sender_uid, content, ts, outgoing FROM zalo_messages WHERE thread_id = ${opts.threadId} ORDER BY ts DESC LIMIT ${limit}`;
    } else {
      rows = this.sql<{
        msg_id: string;
        thread_id: string;
        sender_uid: string;
        content: string;
        ts: number;
        outgoing: number;
      }>`SELECT msg_id, thread_id, sender_uid, content, ts, outgoing FROM zalo_messages ORDER BY ts DESC LIMIT ${limit}`;
    }

    return rows.map((row) => ({
      msgId: row.msg_id,
      threadId: row.thread_id,
      senderUid: row.sender_uid,
      content: row.content,
      ts: row.ts,
      outgoing: row.outgoing === 1,
    }));
  }

  // ── Server-side RPCs (called by worker entry, not exposed via WebSocket) ─

  /**
   * Feed inbound bytes from the Rust bridge.
   * Called by the worker's /cb/:callbackKey handler.
   */
  async pushFrame(bytes: ArrayBuffer): Promise<void> {
    this.ensureSql();

    if (!this.snapshot) {
      console.warn("[ZaloAgent] pushFrame called without active snapshot");
      return;
    }

    const frame = new Uint8Array(bytes);
    this.addActivity({
      kind: "frame_in",
      label: `Inbound frame (${frame.byteLength}B)`,
      byteLen: frame.byteLength,
    });

    try {
      const result = await this.transitionMachineWithInboundFrame(
        this.snapshot,
        frame,
      );
      await this.applyTransition(result);
    } catch (err) {
      console.error("[ZaloAgent] pushFrame transition error:", err);
    }
  }

  /**
   * Handle socket close event from the bridge.
   * If authenticated, attempt auto-reconnect.
   */
  async onSocketClosed(code: number, reason: string): Promise<void> {
    this.ensureSql();

    this.markReconnect();
    this.addActivity({
      kind: "disconnected",
      label: `Socket closed: ${code} ${reason}`,
    });
    this.stopPing();

    if (!this.snapshot) {
      this.setState({
        ...this.state,
        socketStatus: "disconnected",
        updatedAt: Date.now(),
      });
      return;
    }

    // Let the state machine handle ws_closed
    try {
      const result = await this.transitionMachineWithSocketClose(
        this.snapshot,
        code,
        reason,
      );
      if (!result) {
        throw new Error("Socket close transitions are unsupported");
      }

      // The state machine will emit reconnect commands if appropriate
      await this.applyTransition(result);

      // If state machine moved to "reconnecting" and we have credentials,
      // the reconnect command in applyTransition already handles creating
      // a new bridge socket. If it moved to "error", we're done.
    } catch (err) {
      console.error("[ZaloAgent] onSocketClosed transition error:", err);
      this.setState({
        ...this.state,
        phase: "error",
        socketStatus: "error",
        error: err instanceof Error ? err.message : String(err),
        updatedAt: Date.now(),
      });
    }
  }
}

// Required for Agent class type checking
type ConnectionContext = unknown;
