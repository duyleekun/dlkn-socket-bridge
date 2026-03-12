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
  persistReadySession,
  saveSessionState,
} from "./session-store";
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
  buildReqPqMulti,
  buildSendCode,
  handleDHGenResult,
  handleResPQ,
  handleServerDHParams,
  normalizePasswordSrp,
} from "./mtproto/auth-steps";
import { MessageContainer, RPCResult } from "telegram/tl/core";
import { Api } from "telegram/tl";
import type { Env, SessionState } from "./types";

async function saveState(
  env: Env,
  sessionKey: string,
  state: SessionState,
): Promise<void> {
  await saveSessionState(env, sessionKey, state);
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
  const bridge = await createSession(
    bridgeUrl,
    `mtproto-frame://${ipAddress}:${port}`,
    `${normalizeUrl(workerUrl)}/cb/${sessionKey}`,
  );
  const { sendBytes: pqBytes, stateUpdates } = buildReqPqMulti();
  const nextState: SessionState = {
    state: "PQ_SENT",
    authMode: state.authMode,
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
    pendingRequestId: undefined,
    phoneCodeHash: undefined,
    connectionInited: undefined,
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

  await saveState(env, sessionKey, nextState);
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
    error: undefined,
  } as SessionState;
  await saveState(env, sessionKey, nextState);
  await sendFramed(env, sessionKey, state, passwordBytes);
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
    await saveState(env, sessionKey, {
      ...state,
      state: "ERROR",
      error: "sign-up required auth flow is not implemented",
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
  const state = await env.TG_KV.get<SessionState>(`session:${sessionKey}`, "json");
  if (!state) {
    console.warn(`[state-machine] no state for session ${sessionKey}`);
    return;
  }

  if (isQuickAck(rawFrame)) {
    console.log(`[state-machine] quick ack for ${sessionKey}, ignoring`);
    return;
  }

  try {
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
        const { body } = decryptMessage(state.authKey!, payload);
        const response = await deserializeTLResponse(body);
        const innerResult = await unwrapRpcResult(response);

        if (innerResult && (innerResult as { className?: string }).className === "auth.SentCode") {
          const sentCode = innerResult as { phoneCodeHash?: string };
          await saveState(env, sessionKey, {
            ...state,
            state: "AWAITING_CODE",
            phoneCodeHash: sentCode.phoneCodeHash || "",
            error: undefined,
          });
        } else if (innerResult instanceof Api.RpcError) {
          if (!(await requestDcMigrationConfig(env, sessionKey, state, innerResult))) {
            await saveState(env, sessionKey, {
              ...state,
              state: "ERROR",
              error: `sendCode RPC error ${innerResult.errorCode}: ${innerResult.errorMessage}`,
            });
          }
        }
        break;
      }

      case "MIGRATE_CONFIG_SENT": {
        const { body } = decryptMessage(state.authKey!, payload);
        const response = await deserializeTLResponse(body);
        const innerResult = await unwrapRpcResult(response);

        if (innerResult instanceof Api.RpcError) {
          await saveState(env, sessionKey, {
            ...state,
            state: "ERROR",
            error: `getConfig RPC error ${innerResult.errorCode}: ${innerResult.errorMessage}`,
          });
          break;
        }

        const config = innerResult as {
          className?: string;
          dcOptions?: DcOptionLike[];
        };
        if (config.className !== "Config" || !state.migrateToDc) {
          await saveState(env, sessionKey, {
            ...state,
            state: "ERROR",
            error: "unexpected response while resolving migrated DC",
          });
          break;
        }

        const dcOption = pickDcOption(config.dcOptions || [], state.migrateToDc);
        const resolvedDc = dcOption?.ipAddress
          ? {
              id: state.migrateToDc,
              ip: dcOption.ipAddress,
              port: dcOption.port || 443,
            }
          : resolveTelegramDc(state.dcMode, state.migrateToDc);

        await restartAuthOnDc(
          env,
          workerUrl,
          sessionKey,
          state,
          resolvedDc.id,
          resolvedDc.ip,
          resolvedDc.port,
          {
            pendingQrImportTokenBase64Url: state.pendingQrImportTokenBase64Url,
          },
        );
        break;
      }

      case "SIGN_IN_SENT": {
        const { body } = decryptMessage(state.authKey!, payload);
        const response = await deserializeTLResponse(body);
        const innerResult = await unwrapRpcResult(response);

        if (await handleAuthorizationResult(env, sessionKey, state, innerResult, "SIGN_IN_SENT")) {
          break;
        }

        if (innerResult instanceof Api.RpcError) {
          if (!(await requestDcMigrationConfig(env, sessionKey, state, innerResult))) {
            await saveState(env, sessionKey, {
              ...state,
              state: "ERROR",
              error: `signIn RPC error ${innerResult.errorCode}: ${innerResult.errorMessage}`,
            });
          }
        }
        break;
      }

      case "PASSWORD_INFO_SENT": {
        const { body } = decryptMessage(state.authKey!, payload);
        const response = await deserializeTLResponse(body);
        const innerResult = await unwrapRpcResult(response);

        if (innerResult && (innerResult as { className?: string }).className === "account.Password") {
          const passwordInfo = normalizePasswordSrp(
            innerResult as InstanceType<typeof Api.account.Password>,
          );
          if (!passwordInfo.passwordSrp) {
            await saveState(env, sessionKey, {
              ...state,
              state: "ERROR",
              error: "unsupported Telegram password challenge",
            });
            break;
          }
          await saveState(env, sessionKey, {
            ...state,
            state: "AWAITING_PASSWORD",
            passwordHint: passwordInfo.passwordHint,
            passwordSrp: passwordInfo.passwordSrp,
            error: undefined,
          });
        } else if (innerResult instanceof Api.RpcError) {
          await saveState(env, sessionKey, {
            ...state,
            state: "ERROR",
            error: `getPassword RPC error ${innerResult.errorCode}: ${innerResult.errorMessage}`,
          });
        }
        break;
      }

      case "CHECK_PASSWORD_SENT": {
        const { body } = decryptMessage(state.authKey!, payload);
        const response = await deserializeTLResponse(body);
        const innerResult = await unwrapRpcResult(response);

        if (await handleAuthorizationResult(env, sessionKey, state, innerResult, "CHECK_PASSWORD_SENT")) {
          break;
        }

        if (innerResult instanceof Api.RpcError) {
          await saveState(env, sessionKey, {
            ...state,
            state: "ERROR",
            error: `checkPassword RPC error ${innerResult.errorCode}: ${innerResult.errorMessage}`,
          });
        }
        break;
      }

      case "QR_TOKEN_SENT":
      case "QR_IMPORT_SENT": {
        const { body } = decryptMessage(state.authKey!, payload);
        const response = await deserializeTLResponse(body);
        const innerResult = await unwrapRpcResult(response);
        if (!(await handleQrResponse(env, workerUrl, sessionKey, state, innerResult))) {
          await saveState(env, sessionKey, {
            ...state,
            state: "ERROR",
            error: "unexpected QR auth response",
          });
        }
        break;
      }

      case "AWAITING_QR_SCAN": {
        const { body } = decryptMessage(state.authKey!, payload);
        const response = await deserializeTLResponse(body);
        if (containsUpdateLoginToken(response)) {
          const { sendBytes: tokenBytes, stateUpdates } = buildExportLoginToken(
            state,
            env.TELEGRAM_API_ID,
            env.TELEGRAM_API_HASH,
          );
          const nextState = { ...state, ...stateUpdates } as SessionState;
          await saveState(env, sessionKey, nextState);
          await sendFramed(env, sessionKey, state, tokenBytes);
        } else {
          console.log(
            `[state-machine] ${sessionKey}: ignoring update while awaiting QR scan`,
          );
        }
        break;
      }

      case "READY": {
        const { body } = decryptMessage(state.authKey!, payload);
        const response = await deserializeTLResponse(body);
        const innerResult = await unwrapRpcResult(response);

        if (state.pendingRequestId) {
          await env.TG_KV.put(
            `result:${sessionKey}:${state.pendingRequestId}`,
            JSON.stringify(innerResult),
            { expirationTtl: 300 },
          );
          await saveState(env, sessionKey, {
            ...state,
            pendingRequestId: undefined,
          });
        }
        break;
      }

      case "AWAITING_CODE":
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
