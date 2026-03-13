import type { ZaloCredentials } from './state.js';

export type ZaloSessionCommand =
  | { type: 'send_frame'; frame: Uint8Array }
  | { type: 'send_ping' }
  | { type: 'request_old_messages'; threadType: 0 | 1; lastMessageId: string }
  | { type: 'http_login_qr' }
  | { type: 'http_login_creds'; credentials: ZaloCredentials }
  | { type: 'reconnect'; wsUrl: string; headers?: Record<string, string>; firstFrame?: Uint8Array }
  | { type: 'persist_credentials'; credentials: ZaloCredentials; userProfile: import('./state.js').ZaloUserProfile | null; wsUrl: string; pingIntervalMs: number }
  | { type: 'clear_credentials' };
