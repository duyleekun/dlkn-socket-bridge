import type { TelegramUpdatesState } from "gramjs-statemachine";

export type Env = globalThis.Env;

export type TelegramDcMode = "test" | "production";
export type TelegramAuthMode = "phone" | "qr";
export type SocketStatus =
  | "healthy"
  | "unknown"
  | "stale"
  | "closed"
  | "error";
export type {
  TelegramUpdatesState,
  TelegramUpdatesStateSource,
} from "gramjs-statemachine";

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
  updatesState?: TelegramUpdatesState;
  createdAt: number;
  updatedAt: number;
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

export type ParsedPacketKind =
  | "rpc_result"
  | "update"
  | "service"
  | "unknown";

export interface ParsedPacketEntry {
  id: string;
  msgId: string;
  seqNo: number;
  receivedAt: number;
  kind: ParsedPacketKind;
  topLevelClassName?: string;
  reqMsgId?: string;
  requestName?: string;
  resultClassName?: string;
  error?: string;
  summary: string;
  payload: unknown;
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
  persistedSessionRef?: string;
  updatesState?: TelegramUpdatesState;
  socketStatus: SocketStatus;
  socketLastCheckedAt?: number;
  socketLastHealthyAt?: number;
}
