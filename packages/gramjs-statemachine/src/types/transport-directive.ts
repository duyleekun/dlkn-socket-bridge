import type { SerializedState } from './state.js';

export interface ReconnectDirective {
  type: 'reconnect';
  reason: 'dc_migrate' | 'auth_key_unregistered';
  dcId: number;
  dcIp: string;
  dcPort: number;
  nextState: SerializedState;
  firstOutbound: Uint8Array;
}

export type TransportDirective = ReconnectDirective;
