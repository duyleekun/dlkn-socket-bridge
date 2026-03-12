/**
 * Callback-driven state machine for MTProto auth + API flow.
 */

import { createSession, sendBytes } from "./bridge-client";
import { normalizeUrl, resolveBridgeUrl } from "./bridge-url";
import {
  cleanupSocket,
  getSocketErrorStatus,
  isSocketGoneError,
  markSocketState,
} from "./socket-health";
import {
  deleteCallbackBinding,
  loadSessionState,
  persistReadySession,
  saveCallbackBinding,
  saveSessionState,
} from "./session-store";
import {
  appendPacketLog,
  resolvePendingRequest,
  saveConversationCache,
} from "./runtime-store";
import {
  isQuickAck,
  stripTransportFrame,
  wrapTransportFrame,
} from "./mtproto/transport";
import { decryptMessage } from "./mtproto/encrypted-message";
import { deserializeTLResponse } from "./mtproto/serializer";
import { parseMigrateDc, resolveTelegramDc } from "./mtproto/dc";
import {
  buildApiMethod,
  buildExportLoginToken,
  buildGetPassword,
  buildImportLoginToken,
  buildMsgsAck,
  buildReqPqMulti,
  buildSendCode,
  buildSignIn,
  buildSignUp,
  handleDHGenResult,
  handleResPQ,
  handleServerDHParams,
  normalizePasswordSrp,
} from "./mtproto/auth-steps";
import {
  buildConversationCacheFromDialogs,
  parseInboundObject,
} from "./mtproto/inbound";
import { MessageContainer, RPCResult } from "telegram/tl/core";
import { Api } from "telegram/tl";
import type { Env, SessionState } from "./types";

const TEST_DC_SIGN_UP_PROFILE = {
  firstName: "MTProto",
  lastName: "Core Test",
} as const;

function normalizeLongValue(
  value: bigint | string | number | { toString(): string },
): bigint {
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "number") {
    return BigInt(Math.trunc(value));
  }
  if (typeof value === "string") {
    return BigInt(value);
  }
  return BigInt(value.toString());
}

function longToHex(value: bigint | string | number | { toString(): string }): string {
  const bytes = new Uint8Array(8);
  const view = new DataView(bytes.buffer);
  view.setBigInt64(0, BigInt.asIntN(64, normalizeLongValue(value)), true);
  return Buffer.from(bytes).toString("hex");
}

function computeTimeOffsetFromServerMsgId(serverMsgId: bigint): number {
  const now = Math.floor(Date.now() / 1000);
  const correct = Number(serverMsgId >> 32n);
  return correct - now;
}

function applyNewSessionCreatedState(
  state: SessionState,
  value: unknown,
): SessionState {
  if (value instanceof Api.NewSessionCreated) {
    return {
      ...state,
      serverSalt: longToHex(value.serverSalt),
    };
  }

  if (value instanceof MessageContainer) {
    return value.messages.reduce(
      (currentState, message) => applyNewSessionCreatedState(currentState, message.obj),
      state,
    );
  }

  if (value instanceof RPCResult) {
    if (value.body instanceof Uint8Array || Buffer.isBuffer(value.body)) {
      return state;
    }
    return applyNewSessionCreatedState(state, value.body);
  }

  const typed = value as {
    className?: string;
    serverSalt?: bigint | string | number;
    body?: unknown;
    obj?: unknown;
    messages?: Array<{ obj?: unknown; body?: unknown }>;
  } | null;
  if (!typed || typeof typed !== "object") {
    return state;
  }

  if (typed.className === "NewSessionCreated" && typed.serverSalt !== undefined) {
    return {
      ...state,
      serverSalt: longToHex(typed.serverSalt),
    };
  }

  if (Array.isArray(typed.messages)) {
    return typed.messages.reduce((currentState, message) => {
      return applyNewSessionCreatedState(
        currentState,
        message.obj ?? message.body,
      );
    }, state);
  }

  if (typed.obj !== undefined) {
    return applyNewSessionCreatedState(state, typed.obj);
  }
  if (typed.body !== undefined) {
    return applyNewSessionCreatedState(state, typed.body);
  }

  return state;
}

async function deserializeEncryptedResponse(
  env: Env,
  sessionKey: string,
  state: SessionState,
  payload: Uint8Array,
): Promise<{
  decrypted: ReturnType<typeof decryptMessage>;
  response: unknown;
  state: SessionState;
}> {
  const decrypted = decryptMessage(state.authKey!, payload);
  const response = await deserializeTLResponse(decrypted.body);
  const nextState = applyNewSessionCreatedState(state, response);
  if (nextState.serverSalt !== state.serverSalt) {
    await saveState(env, sessionKey, nextState);
  }
  return {
    decrypted,
    response,
    state: nextState,
  };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function maybeRefreshStaleAwaitingCodeState(
  env: Env,
  sessionKey: string,
  state: SessionState,
  rawFrame: Uint8Array,
): Promise<SessionState> {
  if (state.state !== "AWAITING_CODE" || !state.authKey) {
    return state;
  }

  let innerResult: unknown;
  try {
    const payload = stripTransportFrame(rawFrame);
    if (payload.length <= 4) {
      return state;
    }
    const decrypted = decryptMessage(state.authKey, payload);
    const response = await deserializeTLResponse(decrypted.body);
    innerResult = await unwrapRpcResult(response);
  } catch {
    return state;
  }

  const className = (innerResult as { className?: string } | null)?.className;
  if (
    className !== "BadMsgNotification" &&
    className !== "RpcError" &&
    className !== "auth.Authorization" &&
    className !== "auth.AuthorizationSignUpRequired"
  ) {
    return state;
  }

  for (const delay of [10, 50, 150]) {
    await sleep(delay);
    const refreshed = await loadSessionState(env, sessionKey);
    if (refreshed && refreshed.state !== state.state) {
      console.log(
        `[state-machine] ${sessionKey}: refreshed stale ${state.state} state to ${refreshed.state}`,
        { responseClassName: className },
      );
      return refreshed;
    }
  }

  return state;
}

async function saveState(
  env: Env,
  sessionKey: string,
  state: SessionState,
): Promise<void> {
  await saveSessionState(env, sessionKey, state);
}

function latestMsgId(
  left?: string,
  right?: string,
): string | undefined {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return BigInt(left) >= BigInt(right) ? left : right;
}

async function saveReadyTransportState(
  env: Env,
  sessionKey: string,
  state: SessionState,
): Promise<SessionState> {
  const current = await loadSessionState(env, sessionKey);
  if (!current || current.state !== "READY") {
    await saveState(env, sessionKey, state);
    return state;
  }

  const merged = {
    ...current,
    ...state,
    seqNo: Math.max(current.seqNo, state.seqNo),
    lastMsgId: latestMsgId(current.lastMsgId, state.lastMsgId),
  } as SessionState;
  await saveState(env, sessionKey, merged);
  return merged;
}

async function sendFramed(
  env: Env,
  sessionKey: string,
  state: SessionState,
  message: Uint8Array,
): Promise<void> {
  const bridgeUrl = resolveBridgeUrl(state.bridgeUrl);
  try {
    await sendBytes(bridgeUrl, state.socketId, wrapTransportFrame(message));
  } catch (error) {
    if (isSocketGoneError(error)) {
      await cleanupSocket(bridgeUrl, state.socketId);
      await markSocketState(
        env,
        sessionKey,
        getSocketErrorStatus(error),
        error instanceof Error ? error.message : String(error),
      );
    }
    throw error;
  }
}

async function saveRequestResult(
  env: Env,
  sessionKey: string,
  requestId: string,
  result: Record<string, unknown>,
): Promise<void> {
  await env.TG_KV.put(
    `result:${sessionKey}:${requestId}`,
    JSON.stringify(result),
    { expirationTtl: 300 },
  );
}

async function resolvePendingRequestError(
  env: Env,
  sessionKey: string,
  badMsgId: string,
  error: {
    className: string;
    errorCode: number;
    payload?: Record<string, unknown>;
  },
): Promise<void> {
  const request = await resolvePendingRequest(env, sessionKey, badMsgId);
  if (!request) {
    return;
  }
  await saveRequestResult(env, sessionKey, request.requestId, {
    requestId: request.requestId,
    kind: request.kind,
    method: request.method,
    error: `${request.method} ${error.className} ${error.errorCode}`,
    className: error.className,
    payload: error.payload,
    receivedAt: Date.now(),
  });
}

function getMigrateDc(error: Api.RpcError): number | undefined {
  return parseMigrateDc(error.errorMessage);
}

type DcOptionLike = {
  id?: number;
  ipAddress?: string;
  port?: number;
  ipv6?: boolean;
  mediaOnly?: boolean;
  tcpoOnly?: boolean;
  cdn?: boolean;
};

function pickDcOption(
  options: DcOptionLike[],
  targetDc: number,
): DcOptionLike | undefined {
  return options.find((option) =>
    option.id === targetDc &&
    !option.ipv6 &&
    !option.mediaOnly &&
    !option.tcpoOnly &&
    !option.cdn
  ) ?? options.find((option) => option.id === targetDc && !option.ipv6 && !option.cdn);
}

async function requestDcMigrationConfig(
  env: Env,
  sessionKey: string,
  state: SessionState,
  error: Api.RpcError,
): Promise<boolean> {
  const targetDc = getMigrateDc(error);
  if (!targetDc) {
    return false;
  }

  const { sendBytes: configBytes, stateUpdates } = buildApiMethod(
    state,
    env.TELEGRAM_API_ID,
    "help.GetConfig",
    {},
  );
  const nextState = {
    ...state,
    ...stateUpdates,
    state: "MIGRATE_CONFIG_SENT",
    migrateToDc: targetDc,
    error: undefined,
  } as SessionState;

  await saveState(env, sessionKey, nextState);
  await sendFramed(env, sessionKey, state, configBytes);
  console.log(
    `[state-machine] ${sessionKey}: ${state.state} → MIGRATE_CONFIG_SENT (dc ${targetDc})`,
  );
  return true;
}

async function restartAuthOnDc(
  env: Env,
  workerUrl: string,
  sessionKey: string,
  state: SessionState,
  targetDc: number,
  ipAddress: string,
  port: number,
  overrides: Partial<SessionState> = {},
): Promise<void> {
  const bridgeUrl = resolveBridgeUrl(state.bridgeUrl);
  const callbackKey = crypto.randomUUID();
  const bridge = await createSession(
    bridgeUrl,
    `mtproto-frame://${ipAddress}:${port}`,
    `${normalizeUrl(workerUrl)}/cb/${callbackKey}`,
  );
  const { sendBytes: pqBytes, stateUpdates } = buildReqPqMulti();
  const nextState: SessionState = {
    state: "PQ_SENT",
    authMode: state.authMode,
    callbackKey,
    socketId: bridge.socket_id,
    bridgeUrl,
    phone: state.phone,
    dcId: targetDc,
    dcIp: ipAddress,
    dcPort: port,
    dcMode: state.dcMode,
    migrateToDc: undefined,
    seqNo: 0,
    timeOffset: 0,
    phoneCodeHash: undefined,
    connectionInited: undefined,
    pendingPhoneCode: undefined,
    passwordHint: undefined,
    passwordSrp: undefined,
    qrLoginUrl: undefined,
    qrTokenBase64Url: undefined,
    qrExpiresAt: undefined,
    user: undefined,
    error: undefined,
    persistedSessionRef: state.persistedSessionRef,
    socketStatus: "unknown",
    socketLastCheckedAt: undefined,
    socketLastHealthyAt: undefined,
    ...stateUpdates,
    ...overrides,
  };

  await Promise.all([
    saveState(env, sessionKey, nextState),
    saveCallbackBinding(env, callbackKey, sessionKey),
    deleteCallbackBinding(env, state.callbackKey),
  ]);
  await sendFramed(env, sessionKey, nextState, pqBytes);
  await cleanupSocket(bridgeUrl, state.socketId);
  console.log(
    `[state-machine] ${sessionKey}: restarting auth on migrated DC ${targetDc} (${ipAddress}:${port})`,
  );
}

async function requestPasswordInfo(
  env: Env,
  sessionKey: string,
  state: SessionState,
): Promise<void> {
  const { sendBytes: passwordBytes, stateUpdates } = buildGetPassword(
    state,
    env.TELEGRAM_API_ID,
  );
  const nextState = {
    ...state,
    ...stateUpdates,
    pendingPhoneCode: undefined,
    error: undefined,
  } as SessionState;
  await saveState(env, sessionKey, nextState);
  await sendFramed(env, sessionKey, state, passwordBytes);
}

async function retrySignInWithNewServerSalt(
  env: Env,
  sessionKey: string,
  state: SessionState,
  response: InstanceType<typeof Api.BadServerSalt>,
): Promise<void> {
  if (!state.pendingPhoneCode) {
    throw new Error("cannot retry signIn without the submitted phone code");
  }

  const retryState = {
    ...state,
    serverSalt: longToHex(response.newServerSalt),
    error: undefined,
  } as SessionState;
  const { sendBytes: signInBytes, stateUpdates } = buildSignIn(
    retryState,
    env.TELEGRAM_API_ID,
    state.pendingPhoneCode,
  );
  const nextState = {
    ...retryState,
    ...stateUpdates,
  } as SessionState;
  await saveState(env, sessionKey, nextState);
  await sendFramed(env, sessionKey, retryState, signInBytes);
}

async function retrySignUpWithNewServerSalt(
  env: Env,
  sessionKey: string,
  state: SessionState,
  response: InstanceType<typeof Api.BadServerSalt>,
): Promise<void> {
  const retryState = {
    ...state,
    serverSalt: longToHex(response.newServerSalt),
    error: undefined,
  } as SessionState;
  const { sendBytes: signUpBytes, stateUpdates } = buildSignUp(
    retryState,
    env.TELEGRAM_API_ID,
    TEST_DC_SIGN_UP_PROFILE.firstName,
    TEST_DC_SIGN_UP_PROFILE.lastName,
  );
  const nextState = {
    ...retryState,
    ...stateUpdates,
  } as SessionState;
  await saveState(env, sessionKey, nextState);
  await sendFramed(env, sessionKey, retryState, signUpBytes);
}

function recoverFromBadMessage(
  state: SessionState,
  response: InstanceType<typeof Api.BadMsgNotification>,
  serverMsgId: bigint,
): SessionState | null {
  switch (response.errorCode) {
    case 16:
    case 17:
      return {
        ...state,
        timeOffset: computeTimeOffsetFromServerMsgId(serverMsgId),
        lastMsgId: undefined,
        error: undefined,
      };
    case 32:
      return {
        ...state,
        seqNo: state.seqNo + 64,
        lastMsgId: undefined,
        error: undefined,
      };
    case 33:
      return {
        ...state,
        seqNo: Math.max(0, state.seqNo - 16),
        lastMsgId: undefined,
        error: undefined,
      };
    default:
      return null;
  }
}

async function retrySignInWithBadMsgNotification(
  env: Env,
  sessionKey: string,
  state: SessionState,
  response: InstanceType<typeof Api.BadMsgNotification>,
  serverMsgId: bigint,
): Promise<boolean> {
  if (!state.pendingPhoneCode) {
    throw new Error("cannot retry signIn without the submitted phone code");
  }

  const retryState = recoverFromBadMessage(state, response, serverMsgId);
  if (!retryState) {
    return false;
  }

  const { sendBytes: signInBytes, stateUpdates } = buildSignIn(
    retryState,
    env.TELEGRAM_API_ID,
    state.pendingPhoneCode,
  );
  const nextState = {
    ...retryState,
    ...stateUpdates,
  } as SessionState;
  await saveState(env, sessionKey, nextState);
  await sendFramed(env, sessionKey, retryState, signInBytes);
  console.log(`[state-machine] ${sessionKey}: retrying signIn after bad msg`, {
    errorCode: response.errorCode,
    badMsgId: response.badMsgId.toString(),
    serverMsgId: serverMsgId.toString(),
    timeOffset: nextState.timeOffset,
    seqNo: nextState.seqNo,
  });
  return true;
}

async function retrySignUpWithBadMsgNotification(
  env: Env,
  sessionKey: string,
  state: SessionState,
  response: InstanceType<typeof Api.BadMsgNotification>,
  serverMsgId: bigint,
): Promise<boolean> {
  const retryState = recoverFromBadMessage(state, response, serverMsgId);
  if (!retryState) {
    return false;
  }

  const { sendBytes: signUpBytes, stateUpdates } = buildSignUp(
    retryState,
    env.TELEGRAM_API_ID,
    TEST_DC_SIGN_UP_PROFILE.firstName,
    TEST_DC_SIGN_UP_PROFILE.lastName,
  );
  const nextState = {
    ...retryState,
    ...stateUpdates,
  } as SessionState;
  await saveState(env, sessionKey, nextState);
  await sendFramed(env, sessionKey, retryState, signUpBytes);
  console.log(`[state-machine] ${sessionKey}: retrying signUp after bad msg`, {
    errorCode: response.errorCode,
    badMsgId: response.badMsgId.toString(),
    serverMsgId: serverMsgId.toString(),
    timeOffset: nextState.timeOffset,
    seqNo: nextState.seqNo,
  });
  return true;
}

async function startPostAuthFlow(
  env: Env,
  sessionKey: string,
  state: SessionState,
): Promise<void> {
  if (state.pendingQrImportTokenBase64Url) {
    const { sendBytes: importBytes, stateUpdates } = buildImportLoginToken(
      state,
      env.TELEGRAM_API_ID,
      state.pendingQrImportTokenBase64Url,
    );
    const nextState = { ...state, ...stateUpdates } as SessionState;
    await saveState(env, sessionKey, nextState);
    await sendFramed(env, sessionKey, state, importBytes);
    return;
  }

  if (state.authMode === "qr") {
    const { sendBytes: tokenBytes, stateUpdates } = buildExportLoginToken(
      state,
      env.TELEGRAM_API_ID,
      env.TELEGRAM_API_HASH,
    );
    const nextState = {
      ...state,
      ...stateUpdates,
      qrLoginUrl: undefined,
      qrTokenBase64Url: undefined,
      qrExpiresAt: undefined,
    } as SessionState;
    await saveState(env, sessionKey, nextState);
    await sendFramed(env, sessionKey, state, tokenBytes);
    return;
  }

  const { sendBytes: codeBytes, stateUpdates } = buildSendCode(
    state,
    env.TELEGRAM_API_ID,
    env.TELEGRAM_API_HASH,
  );
  const nextState = { ...state, ...stateUpdates } as SessionState;
  await saveState(env, sessionKey, nextState);
  await sendFramed(env, sessionKey, state, codeBytes);
}

async function finalizeReadyState(
  env: Env,
  sessionKey: string,
  state: SessionState,
  user: Record<string, unknown>,
): Promise<void> {
  const readyState: SessionState = {
    ...state,
    state: "READY",
    user,
    error: undefined,
    phoneCodeHash: undefined,
    pendingPhoneCode: undefined,
    passwordHint: undefined,
    passwordSrp: undefined,
    qrLoginUrl: undefined,
    qrTokenBase64Url: undefined,
    qrExpiresAt: undefined,
    pendingQrImportTokenBase64Url: undefined,
  };
  await persistReadySession(env, sessionKey, readyState);
}

function buildQrLoginUrl(token: Uint8Array): string {
  const encoded = Buffer.from(token).toString("base64url");
  return `tg://login?token=${encoded}`;
}

function containsUpdateLoginToken(obj: unknown): boolean {
  if (!obj || typeof obj !== "object") {
    return false;
  }
  if (obj instanceof Api.UpdateLoginToken) {
    return true;
  }
  if (obj instanceof MessageContainer) {
    return obj.messages.some((message) => containsUpdateLoginToken(message.obj));
  }
  if (obj instanceof RPCResult) {
    if (obj.body instanceof Uint8Array || Buffer.isBuffer(obj.body)) {
      return false;
    }
    return containsUpdateLoginToken(obj.body);
  }

  const typed = obj as {
    className?: string;
    updates?: unknown[];
    messages?: Array<{ obj?: unknown; body?: unknown }>;
    body?: unknown;
    update?: unknown;
  };

  if (typed.className === "UpdateLoginToken") {
    return true;
  }
  if (Array.isArray(typed.updates)) {
    return typed.updates.some((update) => containsUpdateLoginToken(update));
  }
  if (Array.isArray(typed.messages)) {
    return typed.messages.some((message) =>
      containsUpdateLoginToken(message.obj ?? message.body),
    );
  }
  if (typed.body !== undefined && containsUpdateLoginToken(typed.body)) {
    return true;
  }
  if (typed.update !== undefined && containsUpdateLoginToken(typed.update)) {
    return true;
  }

  return false;
}

async function handleAuthorizationResult(
  env: Env,
  sessionKey: string,
  state: SessionState,
  innerResult: unknown,
  source: string,
): Promise<boolean> {
  if (innerResult && (innerResult as { className?: string }).className === "auth.Authorization") {
    const auth = innerResult as { user?: Record<string, unknown> };
    await finalizeReadyState(env, sessionKey, state, auth.user || {});
    console.log(`[state-machine] ${sessionKey}: ${source} → READY`);
    return true;
  }

  if (
    innerResult &&
    (innerResult as { className?: string }).className === "auth.AuthorizationSignUpRequired"
  ) {
    if (state.dcMode === "test") {
      // Test DC numbers may require an immediate auth.signUp after auth.signIn.
      const { sendBytes: signUpBytes, stateUpdates } = buildSignUp(
        state,
        env.TELEGRAM_API_ID,
        TEST_DC_SIGN_UP_PROFILE.firstName,
        TEST_DC_SIGN_UP_PROFILE.lastName,
      );
      const nextState = {
        ...state,
        ...stateUpdates,
        error: undefined,
      } as SessionState;
      await saveState(env, sessionKey, nextState);
      await sendFramed(env, sessionKey, state, signUpBytes);
      console.log(`[state-machine] ${sessionKey}: ${source} → SIGN_UP_SENT`);
      return true;
    }
    await saveState(env, sessionKey, {
      ...state,
      state: "ERROR",
      error: "sign-up is only supported for test DC sessions",
    });
    return true;
  }

  if (
    innerResult instanceof Api.RpcError &&
    innerResult.errorMessage === "SESSION_PASSWORD_NEEDED"
  ) {
    await requestPasswordInfo(env, sessionKey, state);
    return true;
  }

  return false;
}

async function handleQrResponse(
  env: Env,
  workerUrl: string,
  sessionKey: string,
  state: SessionState,
  innerResult: unknown,
): Promise<boolean> {
  if (innerResult === undefined) {
    console.log(
      `[state-machine] ${sessionKey}: QR flow received service-only callback in ${state.state}`,
    );
    return true;
  }
  if (await handleAuthorizationResult(env, sessionKey, state, innerResult, state.state)) {
    return true;
  }

  const className = (innerResult as { className?: string } | null)?.className;
  if (className === "auth.LoginToken") {
    const tokenResult = innerResult as { token: Uint8Array; expires: number };
    const qrTokenBase64Url = Buffer.from(tokenResult.token).toString("base64url");
    await saveState(env, sessionKey, {
      ...state,
      state: "AWAITING_QR_SCAN",
      qrTokenBase64Url,
      qrLoginUrl: buildQrLoginUrl(tokenResult.token),
      qrExpiresAt: tokenResult.expires * 1000,
      error: undefined,
    });
    return true;
  }

  if (className === "auth.LoginTokenSuccess") {
    const result = innerResult as {
      authorization?: { className?: string; user?: Record<string, unknown> };
    };
    if (result.authorization?.className === "auth.Authorization") {
      await finalizeReadyState(env, sessionKey, state, result.authorization.user || {});
      return true;
    }
    await saveState(env, sessionKey, {
      ...state,
      state: "ERROR",
      error: "unsupported QR authorization response",
    });
    return true;
  }

  if (className === "auth.LoginTokenMigrateTo") {
    const tokenResult = innerResult as { dcId: number; token: Uint8Array };
    const resolvedDc = resolveTelegramDc(state.dcMode, tokenResult.dcId);
    await restartAuthOnDc(
      env,
      workerUrl,
      sessionKey,
      state,
      resolvedDc.id,
      resolvedDc.ip,
      resolvedDc.port,
      {
        pendingQrImportTokenBase64Url: Buffer.from(tokenResult.token).toString("base64url"),
      },
    );
    return true;
  }

  if (innerResult instanceof Api.RpcError) {
    if (!(await requestDcMigrationConfig(env, sessionKey, state, innerResult))) {
      await saveState(env, sessionKey, {
        ...state,
        state: "ERROR",
        error: `QR auth RPC error ${innerResult.errorCode}: ${innerResult.errorMessage}`,
      });
    }
    return true;
  }

  return false;
}

export async function onResponse(
  env: Env,
  workerUrl: string,
  sessionKey: string,
  rawFrame: Uint8Array,
): Promise<void> {
  let state = await loadSessionState(env, sessionKey);
  if (!state) {
    console.warn(`[state-machine] no state for session ${sessionKey}`);
    return;
  }

  if (isQuickAck(rawFrame)) {
    console.log(`[state-machine] quick ack for ${sessionKey}, ignoring`);
    return;
  }

  try {
    state = await maybeRefreshStaleAwaitingCodeState(
      env,
      sessionKey,
      state,
      rawFrame,
    );
    const payload = stripTransportFrame(rawFrame);

    if (payload.length === 4) {
      const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
      const errorCode = view.getInt32(0, true);
      throw new Error(`MTProto server error: ${errorCode}`);
    }

    switch (state.state) {
      case "PQ_SENT": {
        const { sendBytes: dhBytes, stateUpdates } = handleResPQ(state, payload);
        const nextState = { ...state, ...stateUpdates } as SessionState;
        await saveState(env, sessionKey, nextState);
        await sendFramed(env, sessionKey, state, dhBytes);
        console.log(`[state-machine] ${sessionKey}: PQ_SENT → DH_SENT`);
        break;
      }

      case "DH_SENT": {
        const { sendBytes: setDhBytes, stateUpdates } = handleServerDHParams(
          state,
          payload,
        );
        const nextState = { ...state, ...stateUpdates } as SessionState;
        await saveState(env, sessionKey, nextState);
        await sendFramed(env, sessionKey, state, setDhBytes);
        console.log(`[state-machine] ${sessionKey}: DH_SENT → DH_GEN_SENT`);
        break;
      }

      case "DH_GEN_SENT": {
        const { success, stateUpdates } = await handleDHGenResult(state, payload);
        if (!success) {
          await saveState(env, sessionKey, {
            ...state,
            state: "ERROR",
            error: "DH gen failed",
          });
          return;
        }

        const intermediateState = { ...state, ...stateUpdates } as SessionState;
        await saveState(env, sessionKey, intermediateState);
        await startPostAuthFlow(env, sessionKey, intermediateState);
        console.log(`[state-machine] ${sessionKey}: DH_GEN_SENT → AUTH_KEY_READY`);
        break;
      }

      case "CODE_SENT": {
        const { response, state: hydratedState } = await deserializeEncryptedResponse(
          env,
          sessionKey,
          state,
          payload,
        );
        const innerResult = await unwrapRpcResult(response);

        if (innerResult && (innerResult as { className?: string }).className === "auth.SentCode") {
          const sentCode = innerResult as {
            phoneCodeHash?: string;
            type?: { className?: string; length?: number };
          };
          console.log(`[state-machine] ${sessionKey}: auth.sendCode completed`, {
            phone: hydratedState.phone,
            phoneCodeHash: sentCode.phoneCodeHash || "",
            sentCodeType: sentCode.type?.className,
            sentCodeLength: sentCode.type?.length,
          });
          await saveState(env, sessionKey, {
            ...hydratedState,
            state: "AWAITING_CODE",
            phoneCodeHash: sentCode.phoneCodeHash || "",
            phoneCodeLength: sentCode.type?.length,
            error: undefined,
          });
        } else if (innerResult instanceof Api.RpcError) {
          if (!(await requestDcMigrationConfig(env, sessionKey, hydratedState, innerResult))) {
            await saveState(env, sessionKey, {
              ...hydratedState,
              state: "ERROR",
              error: `sendCode RPC error ${innerResult.errorCode}: ${innerResult.errorMessage}`,
            });
          }
        }
        break;
      }

      case "MIGRATE_CONFIG_SENT": {
        const { response, state: hydratedState } = await deserializeEncryptedResponse(
          env,
          sessionKey,
          state,
          payload,
        );
        const innerResult = await unwrapRpcResult(response);

        if (innerResult instanceof Api.RpcError) {
          await saveState(env, sessionKey, {
            ...hydratedState,
            state: "ERROR",
            error: `getConfig RPC error ${innerResult.errorCode}: ${innerResult.errorMessage}`,
          });
          break;
        }

        const config = innerResult as {
          className?: string;
          dcOptions?: DcOptionLike[];
        };
        if (config.className !== "Config" || !hydratedState.migrateToDc) {
          await saveState(env, sessionKey, {
            ...hydratedState,
            state: "ERROR",
            error: "unexpected response while resolving migrated DC",
          });
          break;
        }

        const dcOption = pickDcOption(config.dcOptions || [], hydratedState.migrateToDc);
        const resolvedDc = dcOption?.ipAddress
          ? {
              id: hydratedState.migrateToDc,
              ip: dcOption.ipAddress,
              port: dcOption.port || 443,
            }
          : resolveTelegramDc(hydratedState.dcMode, hydratedState.migrateToDc);

        await restartAuthOnDc(
          env,
          workerUrl,
          sessionKey,
          hydratedState,
          resolvedDc.id,
          resolvedDc.ip,
          resolvedDc.port,
          {
            pendingQrImportTokenBase64Url: hydratedState.pendingQrImportTokenBase64Url,
          },
        );
        break;
      }

      case "SIGN_IN_SENT": {
        const {
          decrypted,
          response,
          state: hydratedState,
        } = await deserializeEncryptedResponse(env, sessionKey, state, payload);
        const innerResult = await unwrapRpcResult(response);
        console.log(`[state-machine] ${sessionKey}: SIGN_IN_SENT received`, {
          className: (innerResult as { className?: string } | null)?.className,
          pendingPhoneCode: Boolean(hydratedState.pendingPhoneCode),
        });

        if (innerResult instanceof Api.BadServerSalt) {
          await retrySignInWithNewServerSalt(env, sessionKey, hydratedState, innerResult);
          break;
        }

        if (innerResult instanceof Api.BadMsgNotification) {
          if (await retrySignInWithBadMsgNotification(
            env,
            sessionKey,
            hydratedState,
            innerResult,
            decrypted.msgId,
          )) {
            break;
          }
          await saveState(env, sessionKey, {
            ...hydratedState,
            state: "ERROR",
            error: `signIn bad_msg_notification ${innerResult.errorCode}`,
          });
          break;
        }

        if (await handleAuthorizationResult(env, sessionKey, hydratedState, innerResult, "SIGN_IN_SENT")) {
          break;
        }

        if (innerResult instanceof Api.RpcError) {
          if (!(await requestDcMigrationConfig(env, sessionKey, hydratedState, innerResult))) {
            await saveState(env, sessionKey, {
              ...hydratedState,
              state: "ERROR",
              error: `signIn RPC error ${innerResult.errorCode}: ${innerResult.errorMessage}`,
            });
          }
        }
        break;
      }

      case "SIGN_UP_SENT": {
        const {
          decrypted,
          response,
          state: hydratedState,
        } = await deserializeEncryptedResponse(env, sessionKey, state, payload);
        const innerResult = await unwrapRpcResult(response);

        if (innerResult instanceof Api.BadServerSalt) {
          await retrySignUpWithNewServerSalt(env, sessionKey, hydratedState, innerResult);
          break;
        }

        if (innerResult instanceof Api.BadMsgNotification) {
          if (await retrySignUpWithBadMsgNotification(
            env,
            sessionKey,
            hydratedState,
            innerResult,
            decrypted.msgId,
          )) {
            break;
          }
          await saveState(env, sessionKey, {
            ...hydratedState,
            state: "ERROR",
            error: `signUp bad_msg_notification ${innerResult.errorCode}`,
          });
          break;
        }

        if (await handleAuthorizationResult(env, sessionKey, hydratedState, innerResult, "SIGN_UP_SENT")) {
          break;
        }

        if (innerResult instanceof Api.RpcError) {
          await saveState(env, sessionKey, {
            ...hydratedState,
            state: "ERROR",
            error: `signUp RPC error ${innerResult.errorCode}: ${innerResult.errorMessage}`,
          });
        }
        break;
      }

      case "PASSWORD_INFO_SENT": {
        const { response, state: hydratedState } = await deserializeEncryptedResponse(
          env,
          sessionKey,
          state,
          payload,
        );
        const innerResult = await unwrapRpcResult(response);

        if (innerResult && (innerResult as { className?: string }).className === "account.Password") {
          const passwordInfo = normalizePasswordSrp(
            innerResult as InstanceType<typeof Api.account.Password>,
          );
          if (!passwordInfo.passwordSrp) {
            await saveState(env, sessionKey, {
              ...hydratedState,
              state: "ERROR",
              error: "unsupported Telegram password challenge",
            });
            break;
          }
          await saveState(env, sessionKey, {
            ...hydratedState,
            state: "AWAITING_PASSWORD",
            passwordHint: passwordInfo.passwordHint,
            passwordSrp: passwordInfo.passwordSrp,
            error: undefined,
          });
        } else if (innerResult instanceof Api.RpcError) {
          await saveState(env, sessionKey, {
            ...hydratedState,
            state: "ERROR",
            error: `getPassword RPC error ${innerResult.errorCode}: ${innerResult.errorMessage}`,
          });
        }
        break;
      }

      case "CHECK_PASSWORD_SENT": {
        const { response, state: hydratedState } = await deserializeEncryptedResponse(
          env,
          sessionKey,
          state,
          payload,
        );
        const innerResult = await unwrapRpcResult(response);

        if (await handleAuthorizationResult(env, sessionKey, hydratedState, innerResult, "CHECK_PASSWORD_SENT")) {
          break;
        }

        if (innerResult instanceof Api.RpcError) {
          await saveState(env, sessionKey, {
            ...hydratedState,
            state: "ERROR",
            error: `checkPassword RPC error ${innerResult.errorCode}: ${innerResult.errorMessage}`,
          });
        }
        break;
      }

      case "QR_TOKEN_SENT":
      case "QR_IMPORT_SENT": {
        const { response, state: hydratedState } = await deserializeEncryptedResponse(
          env,
          sessionKey,
          state,
          payload,
        );
        const innerResult = await unwrapRpcResult(response);
        if (!(await handleQrResponse(env, workerUrl, sessionKey, hydratedState, innerResult))) {
          await saveState(env, sessionKey, {
            ...hydratedState,
            state: "ERROR",
            error: "unexpected QR auth response",
          });
        }
        break;
      }

      case "AWAITING_QR_SCAN": {
        const { response, state: hydratedState } = await deserializeEncryptedResponse(
          env,
          sessionKey,
          state,
          payload,
        );
        if (containsUpdateLoginToken(response)) {
          const { sendBytes: tokenBytes, stateUpdates } = buildExportLoginToken(
            hydratedState,
            env.TELEGRAM_API_ID,
            env.TELEGRAM_API_HASH,
          );
          const nextState = { ...hydratedState, ...stateUpdates } as SessionState;
          await saveState(env, sessionKey, nextState);
          await sendFramed(env, sessionKey, hydratedState, tokenBytes);
        } else {
          console.log(
            `[state-machine] ${sessionKey}: ignoring update while awaiting QR scan`,
          );
        }
        break;
      }

      case "READY": {
        const {
          decrypted,
          response,
          state: hydratedState,
        } = await deserializeEncryptedResponse(env, sessionKey, state, payload);
        const parsed = await parseInboundObject(
          response,
          decrypted.msgId.toString(),
          decrypted.seqNo,
          Date.now(),
        );

        await appendPacketLog(env, sessionKey, parsed.entries);

        if (response instanceof Api.BadMsgNotification) {
          const recoveredState = recoverFromBadMessage(
            hydratedState,
            response,
            decrypted.msgId,
          );
          if (recoveredState) {
            await saveReadyTransportState(env, sessionKey, recoveredState);
            console.log(`[state-machine] ${sessionKey}: recovered READY session after bad msg`, {
              errorCode: response.errorCode,
              badMsgId: response.badMsgId.toString(),
              seqNo: recoveredState.seqNo,
              timeOffset: recoveredState.timeOffset,
            });
          }
          await resolvePendingRequestError(
            env,
            sessionKey,
            response.badMsgId.toString(),
            {
              className: response.className,
              errorCode: response.errorCode,
              payload: {
                badMsgId: response.badMsgId.toString(),
                badMsgSeqno: response.badMsgSeqno,
              },
            },
          );
        }

        for (const rpcResult of parsed.rpcResults) {
          const request = await resolvePendingRequest(
            env,
            sessionKey,
            rpcResult.reqMsgId,
          );
          if (request) {
            await saveRequestResult(env, sessionKey, request.requestId, {
              requestId: request.requestId,
              kind: request.kind,
              method: request.method,
              reqMsgId: rpcResult.reqMsgId,
              className: rpcResult.className,
              payload: rpcResult.payload,
              receivedAt: Date.now(),
            });
          }

          const conversationCache = buildConversationCacheFromDialogs(
            rpcResult.raw,
          );
          if (conversationCache) {
            await saveConversationCache(env, sessionKey, conversationCache);
          }
        }

        const ackMsgIds = [...new Set(parsed.ackMsgIds)];
        if (ackMsgIds.length > 0) {
          const { sendBytes: ackBytes, stateUpdates } = buildMsgsAck(
            hydratedState,
            env.TELEGRAM_API_ID,
            ackMsgIds.map((msgId) => BigInt(msgId)),
          );
          const nextState = {
            ...hydratedState,
            ...stateUpdates,
          } as SessionState;
          await saveReadyTransportState(env, sessionKey, nextState);
          await sendFramed(env, sessionKey, hydratedState, ackBytes);
        }
        break;
      }

      case "AWAITING_CODE":
      {
        const { decrypted, response } = await deserializeEncryptedResponse(
          env,
          sessionKey,
          state,
          payload,
        );
        const inner = await unwrapRpcResult(response);
        console.log(
          `[state-machine] ${sessionKey}: ignoring data in AWAITING_CODE state`,
          {
            className: (inner as { className?: string } | null)?.className,
            serverMsgId: decrypted.msgId.toString(),
          },
        );
        break;
      }
      case "AWAITING_PASSWORD":
      case "ERROR":
        console.log(
          `[state-machine] ${sessionKey}: ignoring data in ${state.state} state`,
        );
        break;

      default:
        console.warn(
          `[state-machine] ${sessionKey}: unhandled state ${state.state}`,
        );
    }
  } catch (error) {
    console.error(`[state-machine] ${sessionKey} error:`, error);
    if (isSocketGoneError(error)) {
      await cleanupSocket(resolveBridgeUrl(state.bridgeUrl), state.socketId);
      await markSocketState(
        env,
        sessionKey,
        getSocketErrorStatus(error),
        error instanceof Error ? error.message : String(error),
      );
      return;
    }
    await saveState(env, sessionKey, {
      ...state,
      state: "ERROR",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function unwrapRpcResult(obj: unknown): Promise<unknown> {
  if (!obj || typeof obj !== "object") return obj;

  if (isIgnorableServiceObject(obj)) {
    return undefined;
  }

  if (obj instanceof Api.RpcError) {
    return obj;
  }

  if (obj instanceof RPCResult) {
    if (obj.error) {
      return obj.error;
    }
    if (obj.body === undefined) {
      return undefined;
    }
    if (obj.body instanceof Uint8Array || Buffer.isBuffer(obj.body)) {
      return unwrapRpcResult(await deserializeTLResponse(new Uint8Array(obj.body)));
    }
    return unwrapRpcResult(obj.body);
  }

  if (obj instanceof MessageContainer) {
    for (const msg of obj.messages) {
      const inner = await unwrapRpcResult(msg.obj);
      if (inner !== undefined) return inner;
    }
    return undefined;
  }

  const typed = obj as {
    className?: string;
    result?: unknown;
    body?: unknown;
    messages?: unknown[];
  };
  if (isIgnorableServiceObject(typed)) {
    return undefined;
  }
  if (typed.className === "RpcResult" && typed.body !== undefined) {
    return unwrapRpcResult(typed.body);
  }
  if (
    (typed.className === "MsgContainer" || typed.className === "MessageContainer") &&
    Array.isArray(typed.messages)
  ) {
    for (const msg of typed.messages) {
      const inner = await unwrapRpcResult(
        (msg as { obj?: unknown; body?: unknown }).obj ??
          (msg as { body?: unknown }).body,
      );
      if (inner !== undefined) return inner;
    }
    return undefined;
  }
  return obj;
}

function isIgnorableServiceObject(obj: unknown): boolean {
  const className = (obj as { className?: string } | null)?.className;
  return className === "NewSessionCreated" || className === "MsgsAck";
}
