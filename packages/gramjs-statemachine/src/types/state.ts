/**
 * The fully serialized state of a gramjs-statemachine session.
 * This is the single source of truth — persist this between callbacks.
 *
 * The state is self-contained and can be stored in any key-value store.
 */
export interface SerializedState {
  version: 1;

  /** Current phase of the state machine */
  phase:
    | 'INIT'
    | 'PQ_SENT'
    | 'DH_SENT'
    | 'DH_GEN_SENT'
    | 'AUTH_KEY_READY'
    | 'CODE_SENT'
    | 'AWAITING_CODE'
    | 'SIGN_IN_SENT'
    | 'PASSWORD_INFO_SENT'
    | 'AWAITING_PASSWORD'
    | 'CHECK_PASSWORD_SENT'
    | 'QR_TOKEN_SENT'
    | 'AWAITING_QR_SCAN'
    | 'QR_IMPORT_SENT'
    | 'READY'
    | 'ERROR';

  // ── DC / Connection info ──────────────────────────────────────────
  dcId: number;
  dcIp: string;
  dcPort: number;
  dcMode: 'production' | 'test';

  // ── App credentials ───────────────────────────────────────────────
  apiId: string;
  apiHash: string;

  // ── MTProto session keys (null before DH completes) ───────────────
  /** hex-encoded 256-byte auth key */
  authKey?: string;
  /** hex-encoded 8-byte auth key ID (sha1(authKey)[12..20]) */
  authKeyId?: string;
  /** hex-encoded 8-byte server salt */
  serverSalt?: string;
  /** time offset between local clock and server time (seconds) */
  timeOffset: number;
  /** current sequence number (content-related messages increment this) */
  sequence: number;
  /** last message ID sent or received (bigint as decimal string) */
  lastMsgId: string;
  /** hex-encoded 8-byte session ID */
  sessionId?: string;
  /** whether InitConnection has been sent */
  connectionInited: boolean;

  // ── DH exchange intermediates (cleared after AUTH_KEY_READY) ──────
  /** hex-encoded 16-byte client nonce */
  dhNonce?: string;
  /** hex-encoded 16-byte server nonce (LE bytes) */
  dhServerNonce?: string;
  /** hex-encoded 32-byte new nonce (LE bytes) */
  dhNewNonce?: string;

  // ── Login state ───────────────────────────────────────────────────
  authMode?: 'phone' | 'qr';
  phone?: string;
  phoneCodeHash?: string;
  phoneCodeLength?: number;
  passwordHint?: string;
  passwordSrp?: {
    algoClass: string;
    g: number;
    pHex: string;
    salt1Hex: string;
    salt2Hex: string;
    srpBHex: string;
    srpId: string;
  };

  // ── Pending requests: msgId → request info ────────────────────────
  pendingRequests: Record<string, { requestName: string; requestId?: string }>;

  // ── Authenticated user (after READY) ─────────────────────────────
  user?: Record<string, unknown>;

  // ── Error info ────────────────────────────────────────────────────
  error?: { message: string; code?: number };
}

/** Create a new initial SerializedState for a given DC */
export function createInitialState(opts: {
  dcId?: number;
  dcIp?: string;
  dcPort?: number;
  dcMode?: 'production' | 'test';
  apiId: string;
  apiHash: string;
}): SerializedState {
  return {
    version: 1,
    phase: 'INIT',
    dcId: opts.dcId ?? 2,
    dcIp: opts.dcIp ?? '149.154.167.50',
    dcPort: opts.dcPort ?? 443,
    dcMode: opts.dcMode ?? 'production',
    apiId: opts.apiId,
    apiHash: opts.apiHash,
    timeOffset: 0,
    sequence: 0,
    lastMsgId: '0',
    connectionInited: false,
    pendingRequests: {},
  };
}
