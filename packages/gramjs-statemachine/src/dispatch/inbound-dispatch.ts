/**
 * Inbound message dispatcher for the gramjs state machine.
 *
 * Receives deserialized MTProto objects and produces Actions + updated state.
 */
import { Api } from 'telegram/tl/index.js';
import { RPCResult, MessageContainer, GZIPPacked } from 'telegram/tl/core/index.js';
import { BinaryReader } from 'telegram/extensions/index.js';
import { readBufferFromBigInt } from 'telegram/Helpers.js';
import type { SerializedState } from '../types/state.js';
import type { Action } from '../types/action.js';
import { parseMigrateDc } from '../dc/dc-resolver.js';

// ── Helpers ──────────────────────────────────────────────────────────

const INTERNAL_FIELDS = new Set([
  'CONSTRUCTOR_ID',
  'SUBCLASS_OF_ID',
  'classType',
  'originalArgs',
]);

function classNameOf(value: unknown): string | undefined {
  const direct = (value as { className?: string } | null)?.className;
  if (direct) return direct;
  const ctorName = (value as { constructor?: { name?: string } } | null)?.constructor?.name;
  if (ctorName && ctorName !== 'Object') return ctorName.replace(/^_+/, '');
  return undefined;
}

function isMessageContainer(value: unknown): value is MessageContainer {
  const className = classNameOf(value);
  return className === 'MessageContainer';
}

function isGzipped(value: unknown): value is GZIPPacked {
  const className = classNameOf(value);
  return className === 'GZIPPacked';
}

function isRpcResult(value: unknown): value is RPCResult {
  const className = classNameOf(value);
  if (className === 'RPCResult') return true;
  if (!value || typeof value !== 'object') return false;
  return 'reqMsgId' in value && ('body' in value || 'error' in value);
}

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function toHexPreview(bytes: Uint8Array | Buffer, maxBytes = 24): string {
  return Buffer.from(bytes.slice(0, maxBytes)).toString('hex');
}

/**
 * Recursively normalize a GramJS TL object into a plain JSON-safe value.
 */
export function normalizeTlValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;

  if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
    return { type: 'bytes', base64url: toBase64Url(value), length: value.length };
  }
  if (Array.isArray(value)) return value.map(normalizeTlValue);
  if (value instanceof Date) return value.toISOString();

  if (typeof value !== 'object') return String(value);

  const typed = value as Record<string, unknown>;
  const normalized: Record<string, unknown> = {};
  const className = classNameOf(value);
  if (className) normalized.className = className;

  for (const key of Object.keys(typed)) {
    if (INTERNAL_FIELDS.has(key)) continue;
    if (key === 'flags' && typed[key] === undefined) continue;
    normalized[key] = normalizeTlValue(typed[key]);
  }
  return normalized;
}

/**
 * Convert a BigInteger server salt to an 8-byte LE hex string.
 */
function bigIntSaltToHex(salt: unknown): string {
  // GramJS stores salts as signed int64 values and writes them with
  // toSignedLittleBuffer(), so preserve that exact representation here.
  try {
    const saltBytes = new Uint8Array(
      readBufferFromBigInt(
        salt as Parameters<typeof readBufferFromBigInt>[0],
        8,
        true,
        true,
      ),
    );
    return Buffer.from(saltBytes).toString('hex');
  } catch {
    // Fallback: try treating as JS bigint
    if (typeof salt === 'bigint') {
      const buf = Buffer.alloc(8);
      buf.writeBigInt64LE(BigInt.asIntN(64, salt));
      return buf.toString('hex');
    }
    return String(salt);
  }
}

// ── Update class names ───────────────────────────────────────────────

const UPDATE_CLASS_NAMES = new Set([
  'UpdateShort',
  'Updates',
  'UpdateShortMessage',
  'UpdateShortChatMessage',
  'UpdateShortSentMessage',
  'UpdatesTooLong',
  'UpdatesCombined',
]);

// ── Login action detection ───────────────────────────────────────────

export function containsUpdateLoginToken(obj: unknown): boolean {
  if (!obj || typeof obj !== 'object') return false;
  if (obj instanceof Api.UpdateLoginToken) return true;
  if (isMessageContainer(obj)) {
    const container = obj as unknown as { messages: Array<{ obj: unknown }> };
    return container.messages.some((message) => containsUpdateLoginToken(message.obj));
  }
  if (isRpcResult(obj)) {
    const rpc = obj as unknown as { body?: unknown };
    if (rpc.body instanceof Uint8Array || Buffer.isBuffer(rpc.body)) return false;
    return containsUpdateLoginToken(rpc.body);
  }

  const typed = obj as {
    className?: string;
    updates?: unknown[];
    messages?: Array<{ obj?: unknown; body?: unknown }>;
    body?: unknown;
    update?: unknown;
  };

  if (typed.className === 'UpdateLoginToken') return true;
  if (Array.isArray(typed.updates)) {
    return typed.updates.some((update) => containsUpdateLoginToken(update));
  }
  if (Array.isArray(typed.messages)) {
    return typed.messages.some((message) => containsUpdateLoginToken(message.obj ?? message.body));
  }
  if (typed.body !== undefined && containsUpdateLoginToken(typed.body)) return true;
  if (typed.update !== undefined && containsUpdateLoginToken(typed.update)) return true;
  return false;
}

export function buildLoginActions(
  requestName: string,
  result: unknown,
  state: SerializedState,
): { actions: Action[]; updatedState: SerializedState } | null {
  const className = classNameOf(result);

  // auth.SentCode -> login_code_sent
  if (className === 'auth.SentCode') {
    const sentCode = result as Record<string, unknown>;
    const phoneCodeHash = (sentCode.phoneCodeHash as string) ?? '';
    const codeType = sentCode.type as Record<string, unknown> | undefined;
    const codeLength = (typeof codeType?.length === 'number' ? codeType.length : 5);
    const updatedState: SerializedState = {
      ...state,
      phase: 'AWAITING_CODE',
      phoneCodeHash,
      phoneCodeLength: codeLength,
    };
    return {
      actions: [{ type: 'login_code_sent', phoneCodeHash, codeLength }],
      updatedState,
    };
  }

  // auth.Authorization -> login_success
  if (result instanceof Api.auth.Authorization || className === 'auth.Authorization') {
    const auth = result as Record<string, unknown>;
    const user = normalizeTlValue(auth.user) as Record<string, unknown>;
    const updatedState: SerializedState = { ...state, phase: 'READY', user };
    return {
      actions: [{ type: 'login_success', user }],
      updatedState,
    };
  }

  // account.Password (response to account.GetPassword) -> login_password_needed
  if (className === 'account.Password' && requestName === 'account.GetPassword') {
    const pwd = result as Record<string, unknown>;
    const hint = (pwd.hint as string) ?? '';
    const algo = pwd.currentAlgo as Record<string, unknown> | undefined;
    const srpB = pwd.srp_B ?? pwd.srpB;
    if (!algo || !srpB) return null;

    const srpData: NonNullable<SerializedState['passwordSrp']> = {
      algoClass: (algo.className as string) ?? '',
      g: (algo.g as number) ?? 0,
      pHex: Buffer.from(algo.p as Uint8Array).toString('hex'),
      salt1Hex: Buffer.from(algo.salt1 as Uint8Array).toString('hex'),
      salt2Hex: Buffer.from(algo.salt2 as Uint8Array).toString('hex'),
      srpBHex: Buffer.from(srpB as Uint8Array).toString('hex'),
      srpId: String((pwd.srpId ?? pwd.srp_id) ?? ''),
    };
    const updatedState: SerializedState = {
      ...state,
      phase: 'AWAITING_PASSWORD',
      passwordHint: hint,
      passwordSrp: srpData,
    };
    return {
      actions: [{ type: 'login_password_needed', hint, srpData }],
      updatedState,
    };
  }

  // auth.LoginToken (response to auth.ExportLoginToken) -> login_qr_url
  if (result instanceof Api.auth.LoginToken || className === 'auth.LoginToken') {
    const token = result as Record<string, unknown>;
    const tokenBase64 = Buffer.from(token.token as Uint8Array).toString('base64url');
    const url = `tg://login?token=${tokenBase64}`;
    const expires = ((token.expires as number) ?? 0) * 1000;
    const updatedState: SerializedState = { ...state, phase: 'AWAITING_QR_SCAN' };
    return {
      actions: [{ type: 'login_qr_url', url, expires }],
      updatedState,
    };
  }

  if (result instanceof Api.auth.LoginTokenSuccess || className === 'auth.LoginTokenSuccess') {
    const authorization = (result as { authorization?: unknown }).authorization;
    if (
      authorization instanceof Api.auth.Authorization ||
      classNameOf(authorization) === 'auth.Authorization'
    ) {
      const user = normalizeTlValue((authorization as Record<string, unknown>).user) as Record<string, unknown>;
      const updatedState: SerializedState = { ...state, phase: 'READY', user };
      return {
        actions: [{ type: 'login_success', user }],
        updatedState,
      };
    }
    return {
      actions: [{ type: 'error', message: 'unsupported QR authorization response' }],
      updatedState: state,
    };
  }

  if (result instanceof Api.auth.LoginTokenMigrateTo || className === 'auth.LoginTokenMigrateTo') {
    const migrate = result as { dcId?: number; token?: Uint8Array };
    if (!migrate.dcId || !migrate.token) {
      return {
        actions: [{ type: 'error', message: 'invalid QR migrate response' }],
        updatedState: state,
      };
    }
    return {
      actions: [{
        type: 'login_qr_migrate',
        targetDcId: migrate.dcId,
        tokenBase64Url: Buffer.from(migrate.token).toString('base64url'),
      }],
      updatedState: state,
    };
  }

  return null;
}

// ── Core dispatch ────────────────────────────────────────────────────

interface DispatchResult {
  actions: Action[];
  updatedState: SerializedState;
}

/**
 * Recursively dispatch a single deserialized TL object, returning Actions
 * and an updated state.
 */
async function dispatchObject(
  state: SerializedState,
  object: unknown,
  msgId: bigint,
  seqNo: number,
): Promise<DispatchResult> {
  // ── MessageContainer ─────────────────────────────────────────────
  if (isMessageContainer(object)) {
    let currentState = state;
    const allActions: Action[] = [];
    for (const msg of (object as unknown as { messages: Array<{ obj: unknown; msgId: bigint; seqNo: number }> }).messages) {
      const { actions, updatedState } = await dispatchObject(currentState, msg.obj, msg.msgId, msg.seqNo);
      allActions.push(...actions);
      currentState = updatedState;
    }
    return { actions: allActions, updatedState: currentState };
  }

  // ── GZIPPacked ───────────────────────────────────────────────────
  if (isGzipped(object)) {
    const packed = object as unknown as { data: Buffer | Uint8Array };
    console.debug('[gramjs-statemachine] gzip decoded', {
      phase: state.phase,
      msgId: msgId.toString(),
      seqNo,
      envelopeClassName: classNameOf(object),
      packedLength: packed.data.length,
      packedPreviewHex: toHexPreview(packed.data),
      note: 'using GramJS-decoded GZIPPacked.data directly',
    });
    const innerReader = new BinaryReader(Buffer.from(packed.data));
    const inner = await Promise.resolve(innerReader.tgReadObject());
    return dispatchObject(state, inner, msgId, seqNo);
  }

  // ── RPCResult ────────────────────────────────────────────────────
  if (isRpcResult(object)) {
    const rpc = object as unknown as {
      reqMsgId: bigint;
      error?: { errorMessage?: string; errorCode?: number };
      body?: unknown;
    };
    const reqMsgIdStr = rpc.reqMsgId.toString();
    const pending = state.pendingRequests[reqMsgIdStr];
    const requestName = pending?.requestName ?? 'Unknown';
    const requestId = pending?.requestId;

    // Remove from pending
    const updatedPending = { ...state.pendingRequests };
    delete updatedPending[reqMsgIdStr];
    let updatedState: SerializedState = { ...state, pendingRequests: updatedPending };

    // Error path
    if (rpc.error) {
      const errMsg = rpc.error.errorMessage ?? 'RPC error';
      const errCode = rpc.error.errorCode;

      // Check for DC migration
      const dcMigrate = parseMigrateDc(errMsg);
      if (dcMigrate !== undefined) {
        return { actions: [{ type: 'dc_migrate', targetDcId: dcMigrate }], updatedState };
      }
      return { actions: [{ type: 'error', message: errMsg, code: errCode }], updatedState };
    }

    // Deserialize body if it's raw bytes
    let result: unknown;
    if (rpc.body instanceof Uint8Array || Buffer.isBuffer(rpc.body)) {
      const reader2 = new BinaryReader(Buffer.from(rpc.body as Uint8Array));
      result = await Promise.resolve(reader2.tgReadObject());
    } else {
      result = rpc.body;
    }
    console.debug('[gramjs-statemachine] rpc_result', {
      phase: state.phase,
      requestName,
      requestId,
      reqMsgId: reqMsgIdStr,
      resultClassName: classNameOf(result),
    });

    // Check for login-specific actions
    const loginResult = buildLoginActions(requestName, result, updatedState);
    if (loginResult) return loginResult;

    return {
      actions: [{ type: 'rpc_result', reqMsgId: reqMsgIdStr, requestName, result: normalizeTlValue(result), requestId }],
      updatedState,
    };
  }

  // ── Named service messages ───────────────────────────────────────
  const className = classNameOf(object);
  const obj = object as Record<string, unknown>;

  // BadServerSalt
  if (className === 'BadServerSalt') {
    const saltHex = bigIntSaltToHex(obj.newServerSalt);
    const updatedState: SerializedState = { ...state, serverSalt: saltHex };
    const actions: Action[] = [
      { type: 'new_salt', salt: saltHex },
      { type: 'bad_msg', errorCode: obj.errorCode as number, badMsgId: String(obj.badMsgId) },
    ];
    return { actions, updatedState };
  }

  // NewSessionCreated
  if (className === 'NewSessionCreated') {
    const saltHex = bigIntSaltToHex(obj.serverSalt);
    const updatedState: SerializedState = { ...state, serverSalt: saltHex };
    return { actions: [{ type: 'new_salt', salt: saltHex }], updatedState };
  }

  // MsgsAck
  if (className === 'MsgsAck') {
    const rawIds = (obj.msgIds ?? []) as unknown[];
    const msgIds = rawIds.map((id) => String(id));
    return { actions: [{ type: 'ack', msgIds }], updatedState: state };
  }

  // Pong
  if (className === 'Pong') {
    return { actions: [], updatedState: state };
  }

  // Updates family
  if (className && UPDATE_CLASS_NAMES.has(className)) {
    if (containsUpdateLoginToken(object)) {
      return { actions: [{ type: 'login_qr_scanned' }], updatedState: state };
    }
    return {
      actions: [{
        type: 'update',
        update: normalizeTlValue(object),
        msgId: msgId.toString(),
        seqNo,
        envelopeClassName: className,
      }],
      updatedState: state,
    };
  }

  // Unknown / other service messages — silently ignore
  return { actions: [], updatedState: state };
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Dispatch an already-decoded inbound TL object.
 *
 * Used when the encrypted MTProto envelope has been parsed by GramJS and we
 * want to preserve the existing reducer/state-transition logic.
 */
export async function dispatchDecodedObject(
  state: SerializedState,
  object: unknown,
  msgId: bigint,
  seqNo: number,
): Promise<DispatchResult> {
  console.debug('[gramjs-statemachine] dispatchDecodedObject', {
    phase: state.phase,
    msgId: msgId.toString(),
    seqNo,
    objectClassName: classNameOf(object),
  });
  return dispatchObject(state, object, msgId, seqNo);
}

/**
 * Dispatch an inbound MTProto payload.
 *
 * @param state   Current serialized state
 * @param body    Raw decrypted inner-data bytes
 * @param msgId   Server message ID
 * @param seqNo   Sequence number
 * @returns       Actions to process + updated state to persist
 */
export async function dispatch(
  state: SerializedState,
  body: Uint8Array,
  msgId: bigint,
  seqNo: number,
): Promise<DispatchResult> {
  const reader = new BinaryReader(Buffer.from(body));
  const object = await Promise.resolve(reader.tgReadObject());
  console.debug('[gramjs-statemachine] dispatch', {
    phase: state.phase,
    msgId: msgId.toString(),
    seqNo,
    objectClassName: classNameOf(object),
  });
  return dispatchDecodedObject(state, object, msgId, seqNo);
}
