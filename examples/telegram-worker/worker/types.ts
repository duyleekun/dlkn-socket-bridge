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

/**
 * Bridge/transport metadata for an active session.
 * Stored separately from SerializedState (pure MTProto protocol state).
 * Both are stored in KV under different key prefixes, joined by sessionKey.
 */
export interface BridgeSession {
  sessionKey: string;
  callbackKey: string;
  socketId: string;
  bridgeUrl: string;
  authMode: TelegramAuthMode;
  phone: string;
  dcMode: TelegramDcMode;
  persistedSessionRef?: string;
  pendingQrImportTokenBase64Url?: string;
  pendingPhoneCode?: string;
  /** QR login URL returned by login_qr_url action (displayed as QR code in UI) */
  qrLoginUrl?: string;
  /** QR login token expiry (unix ms) */
  qrExpiresAt?: number;
  socketStatus: SocketStatus;
  socketLastCheckedAt?: number;
  socketLastHealthyAt?: number;
}
