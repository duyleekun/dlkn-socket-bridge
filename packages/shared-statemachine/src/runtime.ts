export interface SessionTransitionResult<
  TSnapshot,
  TCommand,
  TEvent,
  TView,
> {
  snapshot: TSnapshot;
  commands: TCommand[];
  events: TEvent[];
  view: TView;
}

export interface SessionRuntimeCapabilities {
  supportsSocketClose: boolean;
}

export interface SessionRuntimeAdapter<
  TCreateInput,
  THostEvent,
  TSnapshot,
  TStateValue,
  TCommand,
  TEvent,
  TView,
> {
  capabilities: SessionRuntimeCapabilities;
  createSession(
    input: TCreateInput,
  ): Promise<SessionTransitionResult<TSnapshot, TCommand, TEvent, TView>>;
  transitionSession(
    snapshot: TSnapshot,
    event: THostEvent,
  ): Promise<SessionTransitionResult<TSnapshot, TCommand, TEvent, TView>>;
  selectView(snapshot: TSnapshot): TView;
  getStateValue(snapshot: TSnapshot): TStateValue;
  buildInboundFrameEvent(frame: Uint8Array): THostEvent;
  buildSocketClosedEvent?(code: number, reason: string): THostEvent | null;
}

export interface SessionRuntimeAdapterOptions<
  TCreateInput,
  THostEvent,
  TSnapshot,
  TStateValue,
  TCommand,
  TEvent,
  TView,
> {
  createSession(
    input: TCreateInput,
  ): Promise<SessionTransitionResult<TSnapshot, TCommand, TEvent, TView>>;
  transitionSession(
    snapshot: TSnapshot,
    event: THostEvent,
  ): Promise<SessionTransitionResult<TSnapshot, TCommand, TEvent, TView>>;
  selectView(snapshot: TSnapshot): TView;
  getStateValue(snapshot: TSnapshot): TStateValue;
  buildInboundFrameEvent(frame: Uint8Array): THostEvent;
  buildSocketClosedEvent?(code: number, reason: string): THostEvent | null;
}

export interface RuntimeTransitionPayload<
  TSnapshot,
  TCommand,
  TEvent,
> {
  snapshot: TSnapshot;
  commands: TCommand[];
  events: TEvent[];
}

export function createSessionTransitionResult<
  TSnapshot,
  TCommand,
  TEvent,
  TView,
>(
  snapshot: TSnapshot,
  commands: TCommand[],
  events: TEvent[],
  view: TView,
): SessionTransitionResult<TSnapshot, TCommand, TEvent, TView> {
  return {
    snapshot,
    commands,
    events,
    view,
  };
}

export function withRuntimeView<
  TSnapshot,
  TCommand,
  TEvent,
  TView,
>(
  payload: RuntimeTransitionPayload<TSnapshot, TCommand, TEvent>,
  selectView: (snapshot: TSnapshot) => TView,
): SessionTransitionResult<TSnapshot, TCommand, TEvent, TView> {
  return createSessionTransitionResult(
    payload.snapshot,
    payload.commands,
    payload.events,
    selectView(payload.snapshot),
  );
}

export function createSessionRuntimeAdapter<
  TCreateInput,
  THostEvent,
  TSnapshot,
  TStateValue,
  TCommand,
  TEvent,
  TView,
>(
  options: SessionRuntimeAdapterOptions<
    TCreateInput,
    THostEvent,
    TSnapshot,
    TStateValue,
    TCommand,
    TEvent,
    TView
  >,
): SessionRuntimeAdapter<
  TCreateInput,
  THostEvent,
  TSnapshot,
  TStateValue,
  TCommand,
  TEvent,
  TView
> {
  return {
    capabilities: {
      supportsSocketClose: typeof options.buildSocketClosedEvent === "function",
    },
    ...options,
  };
}

export function supportsSocketClose<
  TCreateInput,
  THostEvent,
  TSnapshot,
  TStateValue,
  TCommand,
  TEvent,
  TView,
>(
  adapter: SessionRuntimeAdapter<
    TCreateInput,
    THostEvent,
    TSnapshot,
    TStateValue,
    TCommand,
    TEvent,
    TView
  >,
): boolean {
  return adapter.capabilities.supportsSocketClose;
}

export const defineSessionRuntimeAdapter = createSessionRuntimeAdapter;
