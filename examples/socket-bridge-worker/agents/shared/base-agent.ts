import { Agent } from "agents";
import type { Connection, ConnectionContext } from "agents";
import type {
  SessionRuntimeAdapter,
  SessionTransitionResult,
} from "shared-statemachine";
import type {
  SocketActivity,
} from "./types";

export interface BridgeConnectionInfo {
  socketKey: string;
}

export interface BridgeAgentState {
  socketActivity: SocketActivity[];
  updatedAt: number;
}

export abstract class SocketBridgeAgent<
  TState extends BridgeAgentState,
> extends Agent<Env, TState> {
  protected abstract readonly platform: "telegram" | "zalo";

  protected activityStateLimit = 20;

  // Frames queued while the bridge data WS is still being established.
  // Drained automatically once the bridge connects via onConnect().
  // NOTE: we persist these to KV storage so they survive across DO instance
  // boundaries (miniflare creates separate instances per WebSocket connection).
  #pendingBridgeFrames: Uint8Array[] = [];
  static readonly #PENDING_FRAMES_KEY = "pending_bridge_frames";

  protected abstract kvGet(key: string): string | null;

  protected abstract kvSet(key: string, value: string): void;

  protected abstract kvDel(key: string): void;

  protected abstract pushFrame(frame: Uint8Array): Promise<void>;

  protected abstract onSocketClosed(code: number, reason: string): Promise<void>;

  protected normalizeState(nextState: TState): TState {
    return nextState;
  }

  protected onActivity(_entry: SocketActivity): void {
    // Subclasses may persist activity history.
  }

  protected replaceState(nextState: TState): void {
    this.setState(this.normalizeState(nextState));
  }

  protected patchState(
    patch: Partial<TState>,
    updatedAt = Date.now(),
  ): void {
    this.replaceState({
      ...this.state,
      ...patch,
      updatedAt: patch.updatedAt ?? updatedAt,
    });
  }

  protected instanceId(): string {
    const instanceName = this.instanceName();
    if (instanceName) {
      return instanceName;
    }
    return this.ctx.id.toString();
  }

  protected instanceName(): string | null {
    try {
      // ctx.id.name is only present when DO was created via idFromName().
      // In miniflare/workerd dev mode this property is often undefined even
      // for named IDs, so we also check our own KV-persisted copy which is
      // written from the browser WebSocket URL the first time a client connects.
      const fromId = (this.ctx.id as DurableObjectId & { name?: string }).name ?? null;
      if (fromId) return fromId;
      return this.kvGet("instance_name");
    } catch {
      return null;
    }
  }

  protected parseJson<T>(raw: string | null): T | null {
    if (!raw) {
      return null;
    }
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  protected resolveRequestOrigin(origin?: string): string {
    if (origin) {
      const normalizedOrigin = origin.trim().replace(/\/+$/, "");
      this.kvSet("request_origin", normalizedOrigin);
      return normalizedOrigin;
    }

    const persistedOrigin = this.kvGet("request_origin");
    if (!persistedOrigin) {
      throw new Error("Missing request origin");
    }
    return persistedOrigin;
  }

  protected loadBridgeInfo(): BridgeConnectionInfo | null {
    const socketKey = this.kvGet("bridge_socket_key");
    if (socketKey) return { socketKey };
    return null;
  }

  protected saveBridgeInfo(info: BridgeConnectionInfo): void {
    this.kvSet("bridge_socket_key", info.socketKey);
  }

  protected clearBridgeInfo(): void {
    this.kvDel("bridge_socket_key");
    // Also clean up old keys for backward compat
    this.kvDel("bridge_socket_id");
    this.kvDel("bridge_url");
    this.kvDel("callback_key");
    this.kvDel("bridge_info");
  }

  protected async createBridgeConnection(
    targetUrl: string,
    options?: { headers?: Record<string, string> },
  ): Promise<BridgeConnectionInfo> {
    const socketKey = crypto.randomUUID();
    const origin = this.resolveRequestOrigin();
    const agentClass = this.platform === "telegram" ? "telegram-agent" : "zalo-agent";
    const instanceName = this.instanceName() ?? this.ctx.id.toString();

    // Data WS URL — bridge connects here (same path browser uses, distinguished by X-Bridge: 1)
    const agentDataWsUrl = `${origin.replace(/^http/, "ws")}/agents/${agentClass}/${instanceName}`;
    console.log("[bridge] createBridgeConnection: instanceName()=", this.instanceName(), "instanceName=", instanceName, "agentDataWsUrl=", agentDataWsUrl);

    const dsStub = this.#durableSocketStub();
    const result = await dsStub.createSession(
      socketKey,
      targetUrl,
      agentDataWsUrl,
      this.platform,
      this.ctx.id.toString(),
      instanceName,
      options?.headers,
    );
    if (!result.ok) {
      throw new Error(`DurableSocket.createSession failed: ${(result as { ok: false; error: string }).error}`);
    }

    const info: BridgeConnectionInfo = { socketKey };
    this.saveBridgeInfo(info);
    return info;
  }

  protected sendBridgeBytes(data: Uint8Array): void {
    for (const conn of this.getConnections()) {
      const state = conn.state as { isBridge?: boolean } | null;
      if (state?.isBridge) {
        conn.send(data);
        return;
      }
    }
    // Bridge data WS not yet connected — persist the frame so it gets sent
    // as soon as the bridge connects (see onConnect flush below).
    // We persist to KV storage because the bridge WebSocket connection may be
    // handled by a different DO instance (e.g. in miniflare local dev).
    console.warn("[bridge] sendBridgeBytes: bridge not yet connected, persisting frame to queue");
    this.#pendingBridgeFrames.push(data);
    this.#persistPendingFrames();
  }

  #persistPendingFrames(): void {
    if (this.#pendingBridgeFrames.length === 0) {
      this.kvDel(SocketBridgeAgent.#PENDING_FRAMES_KEY);
      return;
    }
    // Encode each Uint8Array as a base64 string for JSON serialisation.
    const encoded = this.#pendingBridgeFrames.map((f) => btoa(String.fromCharCode(...f)));
    this.kvSet(SocketBridgeAgent.#PENDING_FRAMES_KEY, JSON.stringify(encoded));
  }

  #loadPersistedFrames(): Uint8Array[] {
    const raw = this.kvGet(SocketBridgeAgent.#PENDING_FRAMES_KEY);
    console.log("[bridge] #loadPersistedFrames: raw=", raw ? `${raw.slice(0, 60)}…` : "null");
    if (!raw) return [];
    try {
      const encoded = JSON.parse(raw) as string[];
      return encoded.map((b64) => {
        const binary = atob(b64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes;
      });
    } catch (err) {
      console.warn("[bridge] #loadPersistedFrames: parse error", err);
      return [];
    }
  }

  protected async closeBridgeConnection(): Promise<void> {
    this.#pendingBridgeFrames = [];
    this.kvDel(SocketBridgeAgent.#PENDING_FRAMES_KEY);
    for (const conn of this.getConnections()) {
      const state = conn.state as { isBridge?: boolean } | null;
      if (state?.isBridge) {
        conn.close(1000, "agent_close");
      }
    }
    this.clearBridgeInfo();
  }

  async onConnect(connection: Connection, ctx: ConnectionContext): Promise<void> {
    if (ctx.request?.headers.get("X-Bridge") === "1") {
      connection.setState({ isBridge: true });
      console.log("[bridge] bridge data WS connected");
      // Load persisted frames (works across DO instance boundaries)
      const persisted = this.#loadPersistedFrames();
      const all = [...this.#pendingBridgeFrames, ...persisted];
      if (all.length > 0) {
        console.log(`[bridge] flushing ${all.length} queued frame(s) to bridge`);
        for (const frame of all) {
          connection.send(frame);
        }
        this.#pendingBridgeFrames = [];
        this.kvDel(SocketBridgeAgent.#PENDING_FRAMES_KEY);
      }
      return;
    }
    // Browser connection — persist the instance name from the URL path so
    // createBridgeConnection can use it even when ctx.id.name is unavailable
    // (e.g. in miniflare where DurableObjectId.name is not exposed).
    if (ctx.request) {
      try {
        const url = new URL(ctx.request.url);
        // Path format: /agents/<agent-class>/<instance-name>
        const parts = url.pathname.split("/").filter(Boolean);
        // parts = ["agents", "<class>", "<name>"]
        if (parts.length >= 3 && parts[0] === "agents") {
          const nameFromUrl = parts[2];
          if (nameFromUrl && !this.kvGet("instance_name")) {
            this.kvSet("instance_name", nameFromUrl);
          }
        }
      } catch {
        // URL parsing failure is non-fatal
      }
    }
    // Default Agents SDK behavior for browser connections
    return super.onConnect?.(connection, ctx);
  }

  async onMessage(connection: Connection, message: string | ArrayBuffer): Promise<void> {
    const state = connection.state as { isBridge?: boolean } | null;
    if (state?.isBridge) {
      if (message instanceof ArrayBuffer) {
        await this.pushFrame(new Uint8Array(message));
      }
      return;
    }
    return super.onMessage?.(connection, message);
  }

  async onClose(connection: Connection, code: number, reason: string, wasClean: boolean): Promise<void> {
    const state = connection.state as { isBridge?: boolean } | null;
    if (state?.isBridge) {
      console.log("[bridge] bridge data WS closed, code:", code, "reason:", reason);
      await this.onSocketClosed(code, reason || "bridge_close");
      return;
    }
    return super.onClose?.(connection, code, reason, wasClean);
  }

  #durableSocketStub() {
    return this.env.DURABLE_SOCKET.get(
      this.env.DURABLE_SOCKET.idFromName("default"),
    );
  }

  protected addActivity(
    activity: Omit<SocketActivity, "id" | "ts">,
    limit = this.activityStateLimit,
  ): SocketActivity {
    const entry: SocketActivity = {
      id: crypto.randomUUID(),
      ts: Date.now(),
      ...activity,
    };
    this.onActivity(entry);
    const next = [...this.state.socketActivity, entry].slice(-limit);
    this.patchState({ socketActivity: next } as Partial<TState>, entry.ts);
    return entry;
  }
}

export abstract class StateMachineBridgeAgent<
  TState extends BridgeAgentState,
  TCreateInput,
  THostEvent,
  TSnapshot,
  TStateValue,
  TCommand,
  TEvent,
  TView,
> extends SocketBridgeAgent<TState> {
  protected abstract readonly runtimeAdapter: SessionRuntimeAdapter<
    TCreateInput,
    THostEvent,
    TSnapshot,
    TStateValue,
    TCommand,
    TEvent,
    TView
  >;

  protected createMachineSession(input: TCreateInput) {
    return this.runtimeAdapter.createSession(input);
  }

  protected transitionMachineSession(
    snapshot: TSnapshot,
    event: THostEvent,
  ) {
    return this.runtimeAdapter.transitionSession(snapshot, event);
  }

  protected transitionMachineWithInboundFrame(
    snapshot: TSnapshot,
    frame: Uint8Array,
  ) {
    return this.transitionMachineSession(
      snapshot,
      this.buildInboundFrameEvent(frame),
    );
  }

  protected transitionMachineWithSocketClose(
    snapshot: TSnapshot,
    code: number,
    reason: string,
  ): Promise<SessionTransitionResult<TSnapshot, TCommand, TEvent, TView> | null> {
    const event = this.buildSocketClosedEvent(code, reason);
    if (!event) {
      return Promise.resolve(null);
    }
    return this.transitionMachineSession(snapshot, event);
  }

  protected selectMachineView(snapshot: TSnapshot): TView {
    return this.runtimeAdapter.selectView(snapshot);
  }

  protected getMachineStateValue(snapshot: TSnapshot): TStateValue {
    return this.runtimeAdapter.getStateValue(snapshot);
  }

  protected buildInboundFrameEvent(frame: Uint8Array): THostEvent {
    return this.runtimeAdapter.buildInboundFrameEvent(frame);
  }

  protected buildSocketClosedEvent(
    code: number,
    reason: string,
  ): THostEvent | null {
    return this.runtimeAdapter.buildSocketClosedEvent?.(code, reason) ?? null;
  }

  protected machineSupportsSocketClose(): boolean {
    return this.runtimeAdapter.capabilities.supportsSocketClose;
  }
}
