export interface Env {
  TELEGRAM_AGENT: DurableObjectNamespace;
  ZALO_AGENT: DurableObjectNamespace;
  BRIDGE_KV: KVNamespace;
  ASSETS: Fetcher;
  TELEGRAM_API_ID: string;
  TELEGRAM_API_HASH: string;
  TELEGRAM_SESSION_COOKIE_SECRET: string;
  ZALO_SESSION_COOKIE_SECRET: string;
  BRIDGE_URL: string;
}

// KV callback routing record — maps callbackKey → Agent DO
export interface CallbackRecord {
  platform: "telegram" | "zalo";
  instanceName?: string; // canonical Agent/DO name when workerd exposes it
  instanceId?: string; // canonical durable object id string for idFromString routing
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

export interface SocketActivity {
  id: string;
  kind: "frame_in" | "frame_out" | "connected" | "disconnected" | "error" | "fsm_transition";
  label: string;
  byteLen?: number;
  ts: number;
}

export interface RecoveryState {
  lastEventSeq: number | null;
  lastEventAt: number | null;
  reconnectCount: number;
}

// ── Telegram parsed / decrypted MTProto packets ──────────────────────────────

export type ParsedPacketKind = "rpc_result" | "update" | "service" | "unknown";

export interface ParsedPacketEntry {
  id: string;               // `frame:${msgId}:${seqNo}`
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
  payload: unknown;         // normalised TL value — safe to JSON.stringify
}

// ── TelegramState ────────────────────────────────────────────────────────────

export type TelegramPhase =
  | "idle"
  | "connecting"
  | "waiting_phone"
  | "waiting_code"
  | "waiting_password"
  | "waiting_qr_scan"
  | "qr_expired"
  | "authenticated"
  | "error";

export interface TelegramState extends RecoveryState {
  phase: TelegramPhase;
  socketStatus: "disconnected" | "connecting" | "connected" | "error";
  qrCode: string | null;
  qrExpiresAt: number | null;
  phoneNumber: string | null;
  codeHash: string | null;
  userProfile: { id: string; firstName: string; lastName?: string; username?: string } | null;
  recentMessages: Array<{ id: string; peerId: string; text: string; ts: number; outgoing: boolean }>;
  socketActivity: SocketActivity[];
  /** Last 50 parsed+decrypted MTProto frames — real-time via setState broadcast */
  parsedPackets: ParsedPacketEntry[];
  error: string | null;
  updatedAt: number;
}

export const DEFAULT_TELEGRAM_STATE: TelegramState = {
  phase: "idle",
  socketStatus: "disconnected",
  qrCode: null,
  qrExpiresAt: null,
  phoneNumber: null,
  codeHash: null,
  userProfile: null,
  recentMessages: [],
  socketActivity: [],
  parsedPackets: [],
  error: null,
  lastEventSeq: null,
  lastEventAt: null,
  reconnectCount: 0,
  updatedAt: 0,
};

// ── ZaloState ────────────────────────────────────────────────────────────────

export type ZaloPhase =
  | "idle"
  | "qr_pending"
  | "qr_scanned"
  | "authenticating"
  | "authenticated"
  | "recovering"
  | "error";

export interface ZaloState extends RecoveryState {
  phase: ZaloPhase;
  socketStatus: "disconnected" | "connecting" | "connected" | "error";
  qrCode: string | null;
  qrExpiresAt: number | null;
  userProfile: { uid: string; displayName: string; avatar?: string } | null;
  recentMessages: Array<{ msgId: string; threadId: string; senderName: string; content: string; ts: number; outgoing: boolean }>;
  socketActivity: SocketActivity[];
  error: string | null;
  updatedAt: number;
}

export const DEFAULT_ZALO_STATE: ZaloState = {
  phase: "idle",
  socketStatus: "disconnected",
  qrCode: null,
  qrExpiresAt: null,
  userProfile: null,
  recentMessages: [],
  socketActivity: [],
  error: null,
  lastEventSeq: null,
  lastEventAt: null,
  reconnectCount: 0,
  updatedAt: 0,
};
