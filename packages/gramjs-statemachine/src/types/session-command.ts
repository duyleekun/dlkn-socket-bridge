import type { ReconnectDirective } from './transport-directive.js';

export interface SendFrameCommand {
  type: 'send_frame';
  frame: Uint8Array;
}

export interface ReconnectCommand {
  type: 'reconnect';
  reason: ReconnectDirective['reason'];
  dcId: number;
  dcIp: string;
  dcPort: number;
  firstFrame: Uint8Array;
}

export type SessionCommand = SendFrameCommand | ReconnectCommand;
