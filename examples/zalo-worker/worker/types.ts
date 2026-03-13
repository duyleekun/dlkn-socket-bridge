export interface Env {
  ZALO_KV: KVNamespace;
  ASSETS: Fetcher;
  ZALO_SESSION_COOKIE_SECRET: string;
  WORKER_URL: string;
}

export type SocketStatus = "healthy" | "unknown" | "stale" | "closed" | "error";

export interface SerializedCookie {
  key: string;
  value: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
}

export interface PersistedZaloSession {
  version: 1;
  persistedSessionRef: string;
  credentials: {
    imei: string;
    cookie: SerializedCookie[];
    userAgent: string;
    language?: string;
  };
  userProfile: { uid: string; displayName: string; avatar: string } | null;
  wsUrl: string;
  pingIntervalMs: number;
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

export interface BridgeSession {
  sessionKey: string;
  callbackKey: string;
  socketId: string;
  bridgeUrl: string;
  persistedSessionRef?: string;
  pendingBacklogRecovery?: boolean;
  socketStatus: SocketStatus;
  socketLastCheckedAt?: number;
  socketLastHealthyAt?: number;
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

export interface ZaloMessage {
  id: string;
  threadId: string;
  threadType: number;
  fromId: string;
  content: string;
  timestamp: number;
  msgType?: string;
  recovered?: boolean;
}

export interface ZaloMessageRecoveryCursor {
  lastUserMessageId?: string;
  lastUserTimestamp?: number;
  lastGroupMessageId?: string;
  lastGroupTimestamp?: number;
  updatedAt?: number;
}
