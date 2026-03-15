import type { SocketParsedEvent } from '../framing/socket.js';
import type { ZaloCredentials, ZaloUserProfile } from './state.js';

export type ZaloProtocolEvent = Exclude<
  SocketParsedEvent,
  { type: 'cipher_key' } | { type: 'duplicate_connection' }
>;

export type ZaloSessionEvent =
  | { type: 'qr_ready'; qrImage: string; qrToken: string; expiresAt: number }
  | { type: 'qr_scanned'; scanInfo: { avatar?: string; displayName?: string } }
  | { type: 'login_success'; credentials: ZaloCredentials; userProfile: ZaloUserProfile }
  | ZaloProtocolEvent;
