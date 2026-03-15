import type { ExtractedSocketMessage } from "zca-js-statemachine";

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

export type ZaloMessage = ExtractedSocketMessage;

export interface SocketActivityEntry {
  id: string;
  direction: "rx" | "tx";
  timestamp: number;
  type: string;
  summary: string;
  details?: string;
  cmd?: number;
  subCmd?: number;
  payloadKind?: "decrypted" | "wrapper" | "raw";
  bytes: number;
  recovered?: boolean;
}

export function readZaloMessage(message: ZaloMessage): {
  id: string;
  fromId: string;
  content: string;
  timestamp: number;
  msgType: string;
} {
  return {
    id: message.id,
    fromId: message.fromId,
    content: message.content,
    timestamp: message.timestamp,
    msgType: message.msgType,
  };
}

export interface ZaloMessageRecoveryCursor {
  lastUserMessageId?: string;
  lastUserTimestamp?: number;
  lastGroupMessageId?: string;
  lastGroupTimestamp?: number;
  updatedAt?: number;
}
