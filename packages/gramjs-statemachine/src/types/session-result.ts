import type { SerializedState } from './state.js';
import type { SessionEvent } from './session-event.js';
import type { TransportDirective } from './transport-directive.js';

export interface BeginAuthSessionResult {
  nextState: SerializedState;
  outbound: Uint8Array;
  targetDc: {
    id: number;
    ip: string;
    port: number;
  };
}

export interface AdvanceSessionResult {
  nextState: SerializedState;
  outbound: Uint8Array[];
  events: SessionEvent[];
  transport?: TransportDirective;
}
