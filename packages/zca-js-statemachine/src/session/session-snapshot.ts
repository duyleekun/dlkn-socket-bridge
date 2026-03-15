import type { ZaloCredentials, ZaloUserProfile, ZaloSerializedState } from '../types/state.js';

export type ZaloStateMachineValue =
  | 'idle'
  | 'qr_connecting'
  | 'qr_awaiting_scan'
  | 'qr_scanned'
  | 'qr_expired'
  | 'cred_logging_in'
  | 'logged_in'
  | 'ws_connecting'
  | 'listening'
  | 'reconnecting'
  | 'error';

export interface SessionSnapshot {
  version: 1;
  value: ZaloStateMachineValue;
  context: ZaloSerializedState;
}

export type ZaloSessionHostEvent =
  | { type: 'inbound_frame'; frame: Uint8Array }
  | { type: 'ws_closed'; code: number; reason: string }
  | { type: 'http_login_qr_result'; qrData: { image: string; token: string; expiresAt: number } }
  | { type: 'qr_scan_event'; event: 'scanned' | 'confirmed' | 'declined' | 'expired'; data?: unknown }
  | {
      type: 'http_login_creds_result';
      credentials: ZaloCredentials;
      userProfile: ZaloUserProfile;
      wsUrl: string;
      pingIntervalMs: number;
    }
  | { type: 'http_login_failed'; errorMessage: string }
  | { type: 'logout' };

export interface CreateSessionInput {
  mode: 'qr' | 'credentials';
  credentials?: ZaloCredentials;
  userAgent?: string;
  language?: string;
}

export function createSnapshotFromState(
  value: ZaloStateMachineValue,
  context: ZaloSerializedState,
): SessionSnapshot {
  return { version: 1, value, context };
}
