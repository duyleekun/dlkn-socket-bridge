/**
 * Inbound message dispatcher for the gramjs state machine.
 *
 * Receives deserialized MTProto objects and produces internal reducer outputs
 * plus the next serialized state.
 */
import { Api } from 'telegram/tl/index.js';
import { RPCResult, MessageContainer } from 'telegram/tl/core/index.js';
import { readBufferFromBigInt } from 'telegram/Helpers.js';
import type { SerializedState } from '../types/state.js';
import type { InternalAction } from '../types/internal-action.js';
import { parseMigrateDc } from '../dc/dc-resolver.js';
import { readTlObject, readTlObjectUnwrapped, unwrapTlObject } from '../tl/read-object.js';

// ── Helpers ──────────────────────────────────────────────────────────

const INTERNAL_FIELDS = new Set([
  'CONSTRUCTOR_ID',
  'SUBCLASS_OF_ID',
  'classType',
  'originalArgs',
]);

export type DecryptedFrameKind = 'rpc_result' | 'update' | 'service' | 'unknown';

export interface ParsedRpcResultFrame {
  kind: 'rpc_result';
  reqMsgId: string;
  requestName?: string;
  result: unknown;
  normalizedResult: unknown;
  resultClassName?: string;
  error?: {
    message: string;
    code?: number;
  };
}

export function getTlObjectClassName(value: unknown): string | undefined {
  const direct = (value as { className?: string } | null)?.className;
  if (direct) return direct;
  const ctorName = (value as { constructor?: { name?: string } } | null)?.constructor?.name;
  if (ctorName && ctorName !== 'Object') return ctorName.replace(/^_+/, '');
  return undefined;
}

function isMessageContainer(value: unknown): value is MessageContainer {
  const className = getTlObjectClassName(value);
  return className === 'MessageContainer';
}

function isRpcResult(value: unknown): value is RPCResult {
  const className = getTlObjectClassName(value);
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
  const className = getTlObjectClassName(value);
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

async function decodeRpcResultBody(body: unknown): Promise<unknown> {
  if (!(body instanceof Uint8Array) && !Buffer.isBuffer(body)) {
    return body;
  }
  return readTlObjectUnwrapped(body as Uint8Array);
}

export async function unwrapGzippedTlObject(value: unknown): Promise<unknown> {
  return unwrapTlObject(value);
}

export function classifyDecryptedFrame(value: unknown): DecryptedFrameKind {
  if (isRpcResult(value)) {
    return 'rpc_result';
  }
  const className = getTlObjectClassName(value);
  if (className && UPDATE_CLASS_NAMES.has(className)) {
    return 'update';
  }
  if (className) {
    return 'service';
  }
  return 'unknown';
}

export async function parseRpcResultFrame(
  value: unknown,
  opts: {
    pendingRequests?: SerializedState['pendingRequests'];
    requestName?: string;
  } = {},
): Promise<ParsedRpcResultFrame | null> {
  if (!isRpcResult(value)) {
    return null;
  }

  const rpc = value as unknown as {
    reqMsgId: bigint;
    error?: { errorMessage?: string; errorCode?: number };
    body?: unknown;
  };
  const reqMsgId = rpc.reqMsgId.toString();
  const requestName = opts.requestName ?? opts.pendingRequests?.[reqMsgId]?.requestName;

  if (rpc.error) {
    return {
      kind: 'rpc_result',
      reqMsgId,
      requestName,
      result: null,
      normalizedResult: null,
      error: {
        message: rpc.error.errorMessage ?? 'RPC error',
        code: rpc.error.errorCode,
      },
    };
  }

  const result = await unwrapGzippedTlObject(await decodeRpcResultBody(rpc.body));
  return {
    kind: 'rpc_result',
    reqMsgId,
    requestName,
    result,
    normalizedResult: normalizeTlValue(result),
    resultClassName: getTlObjectClassName(result),
  };
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

// ── Login state transitions ──────────────────────────────────────────

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
): { actions: InternalAction[]; updatedState: SerializedState } | null {
  const className = getTlObjectClassName(result);

  // auth.SentCode -> populate awaiting-code state
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
      actions: [],
      updatedState,
    };
  }

  // auth.Authorization -> authenticated READY state
  if (result instanceof Api.auth.Authorization || className === 'auth.Authorization') {
    const auth = result as Record<string, unknown>;
    const user = normalizeTlValue(auth.user) as Record<string, unknown>;
    const updatedState: SerializedState = {
      ...state,
      phase: 'READY',
      user,
      pendingQrImportTokenBase64Url: undefined,
      qrLoginUrl: undefined,
      qrExpiresAt: undefined,
    };
    return {
      actions: [],
      updatedState,
    };
  }

  // account.Password (response to account.GetPassword) -> populate 2FA state
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
      actions: [],
      updatedState,
    };
  }

  // auth.LoginToken (response to auth.ExportLoginToken) -> store QR metadata
  if (result instanceof Api.auth.LoginToken || className === 'auth.LoginToken') {
    const token = result as Record<string, unknown>;
    const tokenBase64 = Buffer.from(token.token as Uint8Array).toString('base64url');
    const url = `tg://login?token=${tokenBase64}`;
    const expires = ((token.expires as number) ?? 0) * 1000;
    const updatedState: SerializedState = {
      ...state,
      phase: 'AWAITING_QR_SCAN',
      qrLoginUrl: url,
      qrExpiresAt: expires,
    };
    return {
      actions: [],
      updatedState,
    };
  }

  if (result instanceof Api.auth.LoginTokenSuccess || className === 'auth.LoginTokenSuccess') {
    const authorization = (result as { authorization?: unknown }).authorization;
    if (
      authorization instanceof Api.auth.Authorization ||
      getTlObjectClassName(authorization) === 'auth.Authorization'
    ) {
      const user = normalizeTlValue((authorization as Record<string, unknown>).user) as Record<string, unknown>;
      const updatedState: SerializedState = {
        ...state,
        phase: 'READY',
        user,
        pendingQrImportTokenBase64Url: undefined,
        qrLoginUrl: undefined,
        qrExpiresAt: undefined,
      };
      return {
        actions: [],
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
  actions: InternalAction[];
  updatedState: SerializedState;
  object: unknown;
  parsedRpc: ParsedRpcResultFrame | null;
}

/**
 * Recursively dispatch a single deserialized TL object, returning reducer
 * outputs and the updated serialized state.
 */
async function dispatchObject(
  state: SerializedState,
  object: unknown,
  msgId: bigint,
  seqNo: number,
  parsedRpc: ParsedRpcResultFrame | null = null,
): Promise<DispatchResult> {
  // ── MessageContainer ─────────────────────────────────────────────
  if (isMessageContainer(object)) {
    let currentState = state;
    const allActions: InternalAction[] = [];
    for (const msg of (object as unknown as { messages: Array<{ obj: unknown; msgId: bigint; seqNo: number }> }).messages) {
      const { actions, updatedState } = await dispatchObject(currentState, msg.obj, msg.msgId, msg.seqNo);
      allActions.push(...actions);
      currentState = updatedState;
    }
    return {
      actions: allActions,
      updatedState: currentState,
      object,
      parsedRpc,
    };
  }

  // ── RPCResult ────────────────────────────────────────────────────
  if (isRpcResult(object)) {
    const rpc = object as unknown as {
      reqMsgId: bigint;
      error?: { errorMessage?: string; errorCode?: number };
      body?: unknown;
    };
    const reqMsgIdStr = rpc.reqMsgId.toString();
    const requestName = parsedRpc?.requestName ?? 'Unknown';

    // Remove from pending
    const updatedPending = { ...state.pendingRequests };
    delete updatedPending[reqMsgIdStr];
    let updatedState: SerializedState = { ...state, pendingRequests: updatedPending };

    // Error path
    if (parsedRpc?.error) {
      const errMsg = parsedRpc.error.message;
      const errCode = parsedRpc.error.code;

      // Check for DC migration
      const dcMigrate = parseMigrateDc(errMsg);
      if (dcMigrate !== undefined) {
        return {
          actions: [{ type: 'dc_migrate', targetDcId: dcMigrate }],
          updatedState,
          object,
          parsedRpc,
        };
      }
      return {
        actions: [{ type: 'error', message: errMsg, code: errCode }],
        updatedState,
        object,
        parsedRpc,
      };
    }

    const result = parsedRpc?.result;
    console.debug('[gramjs-statemachine] rpc_result', {
      phase: state.phase,
      requestName,
      reqMsgId: reqMsgIdStr,
      resultClassName: getTlObjectClassName(result),
    });

    // Check for login-specific actions
    const loginResult = buildLoginActions(requestName, result, updatedState);
    if (loginResult) {
      return {
        ...loginResult,
        object,
        parsedRpc,
      };
    }

    return {
      actions: [],
      updatedState,
      object,
      parsedRpc,
    };
  }

  // ── Named service messages ───────────────────────────────────────
  const className = getTlObjectClassName(object);
  const obj = object as Record<string, unknown>;

  // BadServerSalt
  if (className === 'BadServerSalt') {
    const saltHex = bigIntSaltToHex(obj.newServerSalt);
    const updatedState: SerializedState = { ...state, serverSalt: saltHex };
    const actions: InternalAction[] = [
      { type: 'new_salt', salt: saltHex },
      { type: 'bad_msg', errorCode: obj.errorCode as number, badMsgId: String(obj.badMsgId) },
    ];
    return { actions, updatedState, object, parsedRpc };
  }

  // NewSessionCreated
  if (className === 'NewSessionCreated') {
    const saltHex = bigIntSaltToHex(obj.serverSalt);
    const updatedState: SerializedState = { ...state, serverSalt: saltHex };
    return { actions: [{ type: 'new_salt', salt: saltHex }], updatedState, object, parsedRpc };
  }

  // MsgsAck
  if (className === 'MsgsAck') {
    const rawIds = (obj.msgIds ?? []) as unknown[];
    const msgIds = rawIds.map((id) => String(id));
    return { actions: [{ type: 'ack', msgIds }], updatedState: state, object, parsedRpc };
  }

  // Pong
  if (className === 'Pong') {
    return { actions: [], updatedState: state, object, parsedRpc };
  }

  // Updates family
  if (className && UPDATE_CLASS_NAMES.has(className)) {
    if (containsUpdateLoginToken(object)) {
      return { actions: [{ type: 'login_qr_scanned' }], updatedState: state, object, parsedRpc };
    }
    return {
      actions: [],
      updatedState: state,
      object,
      parsedRpc,
    };
  }

  // Unknown / other service messages — silently ignore
  return { actions: [], updatedState: state, object, parsedRpc };
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
  const unwrappedObject = await unwrapTlObject(object);
  const parsedRpc = await parseRpcResultFrame(unwrappedObject, {
    pendingRequests: state.pendingRequests,
  });
  console.debug('[gramjs-statemachine] dispatchDecodedObject', {
    phase: state.phase,
    msgId: msgId.toString(),
    seqNo,
    objectClassName: getTlObjectClassName(unwrappedObject),
  });
  return dispatchObject(state, unwrappedObject, msgId, seqNo, parsedRpc);
}

/**
 * Dispatch an inbound MTProto payload.
 *
 * @param state   Current serialized state
 * @param body    Raw decrypted inner-data bytes
 * @param msgId   Server message ID
 * @param seqNo   Sequence number
 * @returns       Internal reducer outputs + updated state to persist
 */
export async function dispatch(
  state: SerializedState,
  body: Uint8Array,
  msgId: bigint,
  seqNo: number,
): Promise<DispatchResult> {
  const object = await readTlObject(body);
  console.debug('[gramjs-statemachine] dispatch', {
    phase: state.phase,
    msgId: msgId.toString(),
    seqNo,
    objectClassName: getTlObjectClassName(object),
  });
  return dispatchDecodedObject(state, object, msgId, seqNo);
}
