import { Agent } from "agents";
import type {
  SessionRuntimeAdapter,
  SessionTransitionResult,
} from "shared-statemachine";
import {
  closeSession,
  createSession as createBridgeSession,
} from "./bridge-client";
import { normalizeUrl, resolveBridgeUrl } from "./bridge-url";
import type {
  BridgeCreateResponse,
  CallbackRecord,
  Env,
  SocketActivity,
} from "./types";

export interface BridgeConnectionInfo {
  socketId: string;
  bridgeUrl: string;
  callbackKey: string;
}

export interface BridgeAgentState {
  socketActivity: SocketActivity[];
  updatedAt: number;
}

export abstract class SocketBridgeAgent<
  TState extends BridgeAgentState,
> extends Agent<Env, TState> {
  protected abstract readonly platform: CallbackRecord["platform"];

  protected activityStateLimit = 20;

  protected abstract kvGet(key: string): string | null;

  protected abstract kvSet(key: string, value: string): void;

  protected abstract kvDel(key: string): void;

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
      return (this.ctx.id as DurableObjectId & { name?: string }).name ?? null;
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
      const normalizedOrigin = normalizeUrl(origin);
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
    const socketId = this.kvGet("bridge_socket_id");
    const bridgeUrl = this.kvGet("bridge_url");
    const callbackKey = this.kvGet("callback_key");
    if (socketId && bridgeUrl && callbackKey) {
      return { socketId, bridgeUrl, callbackKey };
    }

    const legacy = this.parseJson<BridgeConnectionInfo>(this.kvGet("bridge_info"));
    if (!legacy?.socketId || !legacy.bridgeUrl || !legacy.callbackKey) {
      return null;
    }

    this.saveBridgeInfo(legacy);
    return legacy;
  }

  protected saveBridgeInfo(info: BridgeConnectionInfo): void {
    this.kvSet("bridge_socket_id", info.socketId);
    this.kvSet("bridge_url", info.bridgeUrl);
    this.kvSet("callback_key", info.callbackKey);
    this.kvSet("bridge_info", JSON.stringify(info));
  }

  protected clearBridgeInfo(): void {
    this.kvDel("bridge_socket_id");
    this.kvDel("bridge_url");
    this.kvDel("callback_key");
    this.kvDel("bridge_info");
  }

  protected async registerCallback(callbackKey: string): Promise<void> {
    const instanceName = this.instanceName();
    const record: CallbackRecord = {
      platform: this.platform,
      instanceId: this.ctx.id.toString(),
      ...(instanceName ? { instanceName } : {}),
    };
    await this.env.BRIDGE_KV.put(
      `callback:${callbackKey}`,
      JSON.stringify(record),
    );
  }

  protected async deleteCallback(callbackKey?: string | null): Promise<void> {
    if (!callbackKey) {
      return;
    }
    await this.env.BRIDGE_KV.delete(`callback:${callbackKey}`);
  }

  protected async createBridgeConnection(
    targetUrl: string,
    options?: { headers?: Record<string, string> },
  ): Promise<BridgeConnectionInfo> {
    const bridgeUrl = resolveBridgeUrl(this.env.BRIDGE_URL);
    const callbackKey = crypto.randomUUID();
    const callbackUrl = `${this.resolveRequestOrigin()}/cb/${callbackKey}`;

    const response = await createBridgeSession(
      bridgeUrl,
      targetUrl,
      callbackUrl,
      options,
    );

    await this.registerCallback(callbackKey);

    const info = {
      socketId: response.socket_id,
      bridgeUrl,
      callbackKey,
    };
    this.saveBridgeInfo(info);
    return info;
  }

  protected async replaceBridgeConnection(
    targetUrl: string,
    options?: { headers?: Record<string, string> },
  ): Promise<{
    previous: BridgeConnectionInfo | null;
    current: BridgeConnectionInfo;
    response: BridgeCreateResponse;
  }> {
    const previous = this.loadBridgeInfo();
    const bridgeUrl = resolveBridgeUrl(this.env.BRIDGE_URL);
    const callbackKey = crypto.randomUUID();
    const callbackUrl = `${this.resolveRequestOrigin()}/cb/${callbackKey}`;

    const response = await createBridgeSession(
      bridgeUrl,
      targetUrl,
      callbackUrl,
      options,
    );

    await this.registerCallback(callbackKey);

    const current = {
      socketId: response.socket_id,
      bridgeUrl,
      callbackKey,
    };
    this.saveBridgeInfo(current);

    await Promise.all([
      this.deleteCallback(previous?.callbackKey),
      previous
        ? closeSession(previous.bridgeUrl, previous.socketId).catch(() => undefined)
        : Promise.resolve(),
    ]);

    return {
      previous,
      current,
      response,
    };
  }

  protected async closeBridgeConnection(): Promise<void> {
    const bridge = this.loadBridgeInfo();
    if (!bridge) {
      return;
    }

    try {
      await closeSession(bridge.bridgeUrl, bridge.socketId);
    } catch {
      // Socket may already be gone; callback cleanup still needs to run.
    }

    await this.deleteCallback(bridge.callbackKey);
    this.clearBridgeInfo();
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
