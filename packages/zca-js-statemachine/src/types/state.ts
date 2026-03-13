export interface SerializedCookie {
  key: string;
  value: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
}

export interface ZaloCredentials {
  imei: string;
  cookie: SerializedCookie[];
  userAgent: string;
  language?: string;
}

export interface ZaloUserProfile {
  uid: string;
  displayName: string;
  avatar: string;
}

export type ZaloPhase =
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

export interface ZaloSerializedState {
  version: 1;
  phase: ZaloPhase;
  // Credentials (persisted after login)
  credentials: ZaloCredentials | null;
  userProfile: ZaloUserProfile | null;
  // QR transient state
  qrData: { image: string; token: string; expiresAt: number } | null;
  // WS session
  cipherKey: string | null;       // base64 AES key from server cmd=1 subCmd=1
  wsUrl: string | null;
  pingIntervalMs: number;
  // Error
  errorMessage: string | null;
  reconnectCount: number;
  lastConnectedAt: number | null;
  // Options
  userAgent: string;
  language: string;
}

export function createInitialState(opts: {
  userAgent?: string;
  language?: string;
  credentials?: ZaloCredentials;
}): ZaloSerializedState {
  return {
    version: 1,
    phase: 'idle',
    credentials: opts.credentials ?? null,
    userProfile: null,
    qrData: null,
    cipherKey: null,
    wsUrl: null,
    pingIntervalMs: 20000,
    errorMessage: null,
    reconnectCount: 0,
    lastConnectedAt: null,
    userAgent: opts.userAgent ?? 'Mozilla/5.0',
    language: opts.language ?? 'vi',
  };
}
