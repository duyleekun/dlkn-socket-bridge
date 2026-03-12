export interface Env {
  TG_KV: KVNamespace;
  ASSETS: Fetcher;
  TELEGRAM_API_ID: string;
  TELEGRAM_API_HASH: string;
  TELEGRAM_SESSION_COOKIE_SECRET: string;
}

export type TelegramDcMode = "test" | "production";
export type TelegramAuthMode = "phone" | "qr";
export type SocketStatus =
  | "healthy"
  | "unknown"
  | "stale"
  | "closed"
  | "error";

export type State =
  | "PQ_SENT"
  | "DH_SENT"
  | "DH_GEN_SENT"
  | "AUTH_KEY_READY"
  | "CODE_SENT"
  | "MIGRATE_CONFIG_SENT"
  | "AWAITING_CODE"
  | "SIGN_IN_SENT"
  | "SIGN_UP_SENT"
  | "PASSWORD_INFO_SENT"
  | "AWAITING_PASSWORD"
  | "CHECK_PASSWORD_SENT"
  | "QR_TOKEN_SENT"
  | "AWAITING_QR_SCAN"
  | "QR_IMPORT_SENT"
  | "READY"
  | "ERROR";

export interface PasswordSrpState {
  algoClass: "PasswordKdfAlgoSHA256SHA256PBKDF2HMACSHA512iter100000SHA256ModPow";
  g: number;
  pHex: string;
  salt1Hex: string;
  salt2Hex: string;
  srpBHex: string;
  srpId: string;
}

export interface SessionState {
  state: State;
  authMode: TelegramAuthMode;
  callbackKey: string;
  socketId: string;
  bridgeUrl?: string;
  phone: string;
  dcMode: TelegramDcMode;
  dcId: number;
  dcIp: string;
  dcPort: number;
  migrateToDc?: number;
  // DH exchange state
  nonce?: string;
  serverNonce?: string;
  newNonce?: string;
  pq?: string;
  p?: string;
  q?: string;
  fingerprint?: string;
  // Auth key material
  authKey?: string;
  authKeyId?: string;
  serverSalt?: string;
  sessionId?: string;
  // MTProto message state
  seqNo: number;
  lastMsgId?: string;
  timeOffset: number;
  // Auth flow
  phoneCodeHash?: string;
  phoneCodeLength?: number;
  connectionInited?: boolean;
  pendingPhoneCode?: string;
  passwordHint?: string;
  passwordSrp?: PasswordSrpState;
  qrLoginUrl?: string;
  qrTokenBase64Url?: string;
  qrExpiresAt?: number;
  pendingQrImportTokenBase64Url?: string;
  persistedSessionRef?: string;
  socketStatus: SocketStatus;
  socketLastCheckedAt?: number;
  socketLastHealthyAt?: number;
  // Result
  user?: Record<string, unknown>;
  error?: string;
}

export interface PersistedTelegramSession {
  version: 1;
  persistedSessionRef: string;
  authMode: TelegramAuthMode;
  phone: string;
  dcMode: TelegramDcMode;
  dcId: number;
  dcIp: string;
  dcPort: number;
  bridgeUrl: string;
  authKey: string;
  authKeyId?: string;
  serverSalt: string;
  timeOffset: number;
  user?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface PersistedSessionLink {
  persistedSessionRef: string;
  liveSessionKey?: string;
  socketId?: string;
  bridgeUrl: string;
  updatedAt: number;
  socketHealth: SocketStatus;
}

export interface BridgeSocketHealth {
  status: SocketStatus;
  socketId: string;
  uptimeSecs?: number;
  bytesRx?: number;
  bytesTx?: number;
  lastCheckedAt: number;
  error?: string;
}

export interface BridgeCreateResponse {
  socket_id: string;
  send_url: string;
  delete_url: string;
}

export interface BridgeStatusResponse {
  protocol: string;
  uptime_secs: number;
  bytes_rx: number;
  bytes_tx: number;
}

export type PendingTelegramRequestKind =
  | "generic"
  | "dialogs"
  | "send_message";

export interface PendingTelegramRequest {
  requestId: string;
  kind: PendingTelegramRequestKind;
  method: string;
  createdAt: number;
}

export interface ParsedPacketEntry {
  id: string;
  msgId: string;
  seqNo: number;
  receivedAt: number;
  requiresAck: boolean;
  className: string;
  envelopeClassName?: string;
  reqMsgId?: string;
  payload: unknown;
}

export type ConversationPeerType = "user" | "chat" | "channel";

export interface ConversationOption {
  id: string;
  peerType: ConversationPeerType;
  peerId: string;
  accessHash?: string;
  title: string;
  subtitle?: string;
  unreadCount?: number;
  topMessage?: number;
}

export interface ConversationCache {
  items: ConversationOption[];
  updatedAt: number;
  totalCount?: number;
}
