"use server";

import { cookies } from "next/headers";
import { env as cfEnv } from "cloudflare:workers";
import {
  closeSession,
  createSession,
  sendBytes,
} from "../../worker/bridge-client";
import { normalizeUrl, resolveBridgeUrl } from "../../worker/bridge-url";
import {
  cleanupSocket,
  getSocketErrorStatus,
  isSocketGoneError,
  markSocketState,
  probeBridgeSocket,
} from "../../worker/socket-health";
import {
  buildCheckPassword,
  buildExportLoginToken,
  buildImportLoginToken,
  buildReqPqMulti,
  buildSendCode,
  buildSignIn,
  buildApiMethod,
} from "../../worker/mtproto/auth-steps";
import { getDefaultTelegramDc } from "../../worker/mtproto/dc";
import {
  SESSION_COOKIE_NAME,
  decryptCookieValue,
  deletePersistedSessionArtifacts,
  deleteSessionState,
  encryptCookieValue,
  loadPersistedLink,
  loadPersistedSession,
  loadSessionState,
  rebuildSessionFromPersisted,
  saveSessionState,
  shouldReuseRuntimeSession,
} from "../../worker/session-store";
import { wrapTransportFrame } from "../../worker/mtproto/transport";
import type {
  BridgeSocketHealth,
  Env,
  SessionState,
  TelegramAuthMode,
  TelegramDcMode,
} from "../../worker/types";

function getEnv(): Env {
  return cfEnv as unknown as Env;
}

async function cookieStore() {
  return cookies();
}

async function readPersistedSessionRefFromCookie(
  env: Env,
): Promise<string | null> {
  const store = await cookieStore();
  const cookie = store.get(SESSION_COOKIE_NAME)?.value;
  if (!cookie) {
    return null;
  }
  return decryptCookieValue(env.TELEGRAM_SESSION_COOKIE_SECRET, cookie);
}

async function writePersistedSessionCookie(
  env: Env,
  persistedSessionRef: string,
): Promise<void> {
  const store = await cookieStore();
  const encrypted = await encryptCookieValue(
    env.TELEGRAM_SESSION_COOKIE_SECRET,
    persistedSessionRef,
  );
  store.set(SESSION_COOKIE_NAME, encrypted, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
}

async function clearPersistedSessionCookie(): Promise<void> {
  const store = await cookieStore();
  store.delete(SESSION_COOKIE_NAME);
}

function toStatusPayload(state: SessionState) {
  return {
    state: state.state,
    authMode: state.authMode,
    phoneCodeHash: state.phoneCodeHash,
    passwordHint: state.passwordHint,
    qrLoginUrl: state.qrLoginUrl,
    qrExpiresAt: state.qrExpiresAt,
    sessionRef: state.persistedSessionRef,
    user: state.user,
    error: state.error,
    socketStatus: state.socketStatus,
    socketLastCheckedAt: state.socketLastCheckedAt,
    socketLastHealthyAt: state.socketLastHealthyAt,
  };
}

async function sendSessionBytes(
  env: Env,
  sessionKey: string,
  state: SessionState,
  payload: Uint8Array,
): Promise<void> {
  try {
    await sendBytes(
      resolveBridgeUrl(state.bridgeUrl),
      state.socketId,
      wrapTransportFrame(payload),
    );
  } catch (error) {
    if (isSocketGoneError(error)) {
      await cleanupSocket(resolveBridgeUrl(state.bridgeUrl), state.socketId);
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

export async function startAuth(input: {
  authMode: TelegramAuthMode;
  phone?: string;
  dcMode?: TelegramDcMode;
  bridgeUrl?: string;
  workerUrl?: string;
}) {
  const env = getEnv();
  const authMode = input.authMode;
  const dcMode = input.dcMode ?? "test";
  const resolvedBridgeUrl = resolveBridgeUrl(input.bridgeUrl);
  const resolvedWorkerUrl = normalizeUrl(input.workerUrl || "");
  const preset = getDefaultTelegramDc(dcMode);
  const sessionKey = crypto.randomUUID();

  const bridge = await createSession(
    resolvedBridgeUrl,
    `mtproto-frame://${preset.ip}:${preset.port}`,
    `${resolvedWorkerUrl}/cb/${sessionKey}`,
  );

  const { sendBytes: pqBytes, stateUpdates } = buildReqPqMulti();
  await sendBytes(
    resolvedBridgeUrl,
    bridge.socket_id,
    wrapTransportFrame(pqBytes),
  );

  const state: SessionState = {
    state: "PQ_SENT",
    authMode,
    socketId: bridge.socket_id,
    bridgeUrl: resolvedBridgeUrl,
    phone: authMode === "phone" ? (input.phone || "").trim() : "",
    dcMode,
    dcId: preset.id,
    dcIp: preset.ip,
    dcPort: preset.port,
    seqNo: 0,
    timeOffset: 0,
    socketStatus: "unknown",
    ...stateUpdates,
  };
  await env.TG_KV.put(`session:${sessionKey}`, JSON.stringify(state));

  return { sessionKey, ...toStatusPayload(state) };
}

export async function getStatus(sessionKey: string) {
  const env = getEnv();
  const state = await loadSessionState(env, sessionKey);
  if (!state) {
    return { error: "not_found" as const };
  }
  if (state.state === "READY" && state.persistedSessionRef) {
    await writePersistedSessionCookie(env, state.persistedSessionRef);
  }
  return toStatusPayload(state);
}

export async function submitCode(sessionKey: string, code: string) {
  const env = getEnv();
  const state = await loadSessionState(env, sessionKey);
  if (!state || state.state !== "AWAITING_CODE") {
    return { error: "invalid_state" as const };
  }

  const { sendBytes: signInBytes, stateUpdates } = buildSignIn(
    state,
    env.TELEGRAM_API_ID,
    code.trim(),
  );
  await sendSessionBytes(env, sessionKey, state, signInBytes);

  const nextState = {
    ...state,
    ...stateUpdates,
  } as SessionState;
  await saveSessionState(env, sessionKey, nextState);

  return { state: nextState.state };
}

export async function submitPassword(sessionKey: string, password: string) {
  const env = getEnv();
  const state = await loadSessionState(env, sessionKey);
  if (!state || state.state !== "AWAITING_PASSWORD") {
    return { error: "invalid_state" as const };
  }

  const { sendBytes: passwordBytes, stateUpdates } = await buildCheckPassword(
    state,
    env.TELEGRAM_API_ID,
    password,
  );
  await sendSessionBytes(env, sessionKey, state, passwordBytes);

  const nextState = {
    ...state,
    ...stateUpdates,
  } as SessionState;
  await saveSessionState(env, sessionKey, nextState);

  return { state: nextState.state };
}

export async function refreshQrToken(sessionKey: string) {
  const env = getEnv();
  const state = await loadSessionState(env, sessionKey);
  if (
    !state ||
    (state.state !== "AWAITING_QR_SCAN" &&
      state.state !== "QR_TOKEN_SENT" &&
      state.state !== "QR_IMPORT_SENT")
  ) {
    return { error: "invalid_state" as const };
  }

  const { sendBytes: tokenBytes, stateUpdates } = buildExportLoginToken(
    state,
    env.TELEGRAM_API_ID,
    env.TELEGRAM_API_HASH,
  );
  await sendSessionBytes(env, sessionKey, state, tokenBytes);

  const nextState = {
    ...state,
    ...stateUpdates,
    qrLoginUrl: undefined,
    qrTokenBase64Url: undefined,
    qrExpiresAt: undefined,
  } as SessionState;
  await saveSessionState(env, sessionKey, nextState);

  return { state: nextState.state };
}

export async function restoreSessionFromCookie(
  bridgeUrl?: string,
  workerUrl?: string,
) {
  const env = getEnv();
  const persistedSessionRef = await readPersistedSessionRefFromCookie(env);
  if (!persistedSessionRef) {
    await clearPersistedSessionCookie();
    return { restored: false as const };
  }

  const persisted = await loadPersistedSession(env, persistedSessionRef);
  if (!persisted) {
    await clearPersistedSessionCookie();
    return { restored: false as const };
  }

  const link = await loadPersistedLink(env, persistedSessionRef);
  if (link?.liveSessionKey) {
    const liveState = await loadSessionState(env, link.liveSessionKey);
    if (liveState) {
      const health = await probeBridgeSocket(env, link.liveSessionKey, liveState);
      if (shouldReuseRuntimeSession(liveState, health.status)) {
        await writePersistedSessionCookie(env, persistedSessionRef);
        const refreshedState = await loadSessionState(env, link.liveSessionKey);
        return {
          restored: true as const,
          sessionKey: link.liveSessionKey,
          health,
          ...toStatusPayload(refreshedState || liveState),
        };
      }
    }

    if (link.socketId) {
      await cleanupSocket(link.bridgeUrl, link.socketId);
    }
    await deleteSessionState(env, link.liveSessionKey);
  }

  const rebuilt = await rebuildSessionFromPersisted(
    env,
    normalizeUrl(workerUrl || ""),
    persisted,
    bridgeUrl,
  );
  const health = await probeBridgeSocket(env, rebuilt.sessionKey, rebuilt.state);
  await writePersistedSessionCookie(env, persistedSessionRef);
  const restoredState = await loadSessionState(env, rebuilt.sessionKey);
  return {
    restored: true as const,
    sessionKey: rebuilt.sessionKey,
    health,
    ...toStatusPayload(restoredState || rebuilt.state),
  };
}

export async function logoutSession(sessionKey?: string) {
  const env = getEnv();
  let persistedSessionRef = await readPersistedSessionRefFromCookie(env);
  let activeState: SessionState | null = null;

  if (sessionKey) {
    activeState = await loadSessionState(env, sessionKey);
    persistedSessionRef = activeState?.persistedSessionRef || persistedSessionRef;
  }

  if (activeState?.socketId && activeState.bridgeUrl) {
    await cleanupSocket(activeState.bridgeUrl, activeState.socketId);
  }

  if (sessionKey) {
    await deleteSessionState(env, sessionKey);
  }

  if (persistedSessionRef) {
    const link = await loadPersistedLink(env, persistedSessionRef);
    if (link?.socketId) {
      await cleanupSocket(link.bridgeUrl, link.socketId);
    }
    if (link?.liveSessionKey && link.liveSessionKey !== sessionKey) {
      await deleteSessionState(env, link.liveSessionKey);
    }
    await deletePersistedSessionArtifacts(env, persistedSessionRef);
  }

  await clearPersistedSessionCookie();
  return { ok: true as const };
}

export async function getBridgeSocketHealth(
  sessionKey: string,
): Promise<BridgeSocketHealth | { error: "not_found" }> {
  const env = getEnv();
  const state = await loadSessionState(env, sessionKey);
  if (!state) {
    return { error: "not_found" as const };
  }
  const health = await probeBridgeSocket(env, sessionKey, state);
  return health;
}

export async function sendTelegramMethod(
  sessionKey: string,
  method: string,
  params: Record<string, unknown>,
) {
  const env = getEnv();
  const state = await loadSessionState(env, sessionKey);
  if (!state || state.state !== "READY") {
    return { error: "not_ready" as const };
  }

  const requestId = crypto.randomUUID();
  const { sendBytes: methodBytes, stateUpdates } = buildApiMethod(
    state,
    env.TELEGRAM_API_ID,
    method,
    params,
  );
  await sendSessionBytes(env, sessionKey, state, methodBytes);

  const nextState = {
    ...state,
    ...stateUpdates,
    pendingRequestId: requestId,
  } as SessionState;
  await saveSessionState(env, sessionKey, nextState);

  return { requestId };
}

export async function getResult(sessionKey: string, requestId: string) {
  const env = getEnv();
  const result = await env.TG_KV.get(
    `result:${sessionKey}:${requestId}`,
    "json",
  );
  return result || { pending: true as const };
}

export async function closeCurrentSocket(sessionKey: string) {
  const env = getEnv();
  const state = await loadSessionState(env, sessionKey);
  if (!state) {
    return { error: "not_found" as const };
  }

  try {
    await closeSession(resolveBridgeUrl(state.bridgeUrl), state.socketId);
  } catch (error) {
    if (!isSocketGoneError(error)) {
      throw error;
    }
  }
  await markSocketState(env, sessionKey, "closed", "socket closed by user");
  return { ok: true as const };
}
