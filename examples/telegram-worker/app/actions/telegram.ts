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
  buildGetDialogs,
  buildCheckPassword,
  buildExportLoginToken,
  buildImportLoginToken,
  buildReqPqMulti,
  buildSendMessage,
  buildSendCode,
  buildSignIn,
  buildApiMethod,
} from "../../worker/mtproto/auth-steps";
import { buildInputPeerFromConversation } from "../../worker/mtproto/inbound";
import { getDefaultTelegramDc } from "../../worker/mtproto/dc";
import {
  clearRuntimeArtifacts,
  loadConversationCache,
  loadPacketLog,
  trackPendingRequest,
} from "../../worker/runtime-store";
import {
  deleteCallbackBinding,
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
  saveCallbackBinding,
  shouldReuseRuntimeSession,
} from "../../worker/session-store";
import { wrapTransportFrame } from "../../worker/mtproto/transport";
import type {
  BridgeSocketHealth,
  ConversationCache,
  Env,
  ParsedPacketEntry,
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
    phoneCodeLength: state.phoneCodeLength,
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

async function dispatchReadyRequest(
  env: Env,
  sessionKey: string,
  request: {
    requestId: string;
    kind: "generic" | "dialogs" | "send_message";
    method: string;
  },
  build: (state: SessionState) => {
    sendBytes: Uint8Array;
    stateUpdates: Partial<SessionState>;
    msgId?: string;
  },
): Promise<{ requestId: string } | { error: "not_ready" }> {
  const state = await loadSessionState(env, sessionKey);
  if (!state || state.state !== "READY") {
    return { error: "not_ready" as const };
  }

  const built = build(state);
  if (!built.msgId) {
    throw new Error(`request ${request.method} is missing outbound msgId`);
  }

  const nextState = {
    ...state,
    ...built.stateUpdates,
  } as SessionState;

  await Promise.all([
    saveSessionState(env, sessionKey, nextState),
    trackPendingRequest(env, sessionKey, built.msgId, {
      ...request,
      createdAt: Date.now(),
    }),
  ]);
  await sendSessionBytes(env, sessionKey, nextState, built.sendBytes);

  return { requestId: request.requestId };
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
  const callbackKey = crypto.randomUUID();

  const bridge = await createSession(
    resolvedBridgeUrl,
    `mtproto-frame://${preset.ip}:${preset.port}`,
    `${resolvedWorkerUrl}/cb/${callbackKey}`,
  );

  const { sendBytes: pqBytes, stateUpdates } = buildReqPqMulti();
  const state: SessionState = {
    state: "PQ_SENT",
    authMode,
    callbackKey,
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
  await Promise.all([
    saveSessionState(env, sessionKey, state),
    saveCallbackBinding(env, callbackKey, sessionKey),
  ]);
  await sendBytes(
    resolvedBridgeUrl,
    bridge.socket_id,
    wrapTransportFrame(pqBytes),
  );

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
    console.warn("[actions.submitCode] invalid state", {
      sessionKey,
      currentState: state?.state,
    });
    return { error: "invalid_state" as const };
  }

  const { sendBytes: signInBytes, stateUpdates } = buildSignIn(
    state,
    env.TELEGRAM_API_ID,
    code.trim(),
  );
  const nextState = {
    ...state,
    ...stateUpdates,
    pendingPhoneCode: code.trim(),
  } as SessionState;
  await saveSessionState(env, sessionKey, nextState);
  console.log("[actions.submitCode] saved SIGN_IN_SENT", {
    sessionKey,
    previousState: state.state,
    nextState: nextState.state,
    phone: nextState.phone,
    phoneCodeHash: nextState.phoneCodeHash,
    phoneCodeLength: nextState.phoneCodeLength,
  });
  await sendSessionBytes(env, sessionKey, nextState, signInBytes);
  console.log("[actions.submitCode] sent signIn bytes", {
    sessionKey,
    pendingPhoneCode: nextState.pendingPhoneCode,
  });

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
  const nextState = {
    ...state,
    ...stateUpdates,
  } as SessionState;
  await saveSessionState(env, sessionKey, nextState);
  await sendSessionBytes(env, sessionKey, nextState, passwordBytes);

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
  const nextState = {
    ...state,
    ...stateUpdates,
    qrLoginUrl: undefined,
    qrTokenBase64Url: undefined,
    qrExpiresAt: undefined,
  } as SessionState;
  await saveSessionState(env, sessionKey, nextState);
  await sendSessionBytes(env, sessionKey, nextState, tokenBytes);

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
    if (liveState?.callbackKey) {
      await deleteCallbackBinding(env, liveState.callbackKey);
    }
    await deleteSessionState(env, link.liveSessionKey);
    await clearRuntimeArtifacts(env, link.liveSessionKey);
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
    await deleteCallbackBinding(env, activeState?.callbackKey);
    await deleteSessionState(env, sessionKey);
    await clearRuntimeArtifacts(env, sessionKey);
  }

  if (persistedSessionRef) {
    const link = await loadPersistedLink(env, persistedSessionRef);
    if (link?.socketId) {
      await cleanupSocket(link.bridgeUrl, link.socketId);
    }
    if (link?.liveSessionKey && link.liveSessionKey !== sessionKey) {
      const linkedState = await loadSessionState(env, link.liveSessionKey);
      await deleteCallbackBinding(env, linkedState?.callbackKey);
      await deleteSessionState(env, link.liveSessionKey);
      await clearRuntimeArtifacts(env, link.liveSessionKey);
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
  const requestId = crypto.randomUUID();
  return dispatchReadyRequest(
    env,
    sessionKey,
    {
      requestId,
      kind: "generic",
      method,
    },
    (state) => buildApiMethod(
      state,
      env.TELEGRAM_API_ID,
      method,
      params,
    ),
  );
}

export async function getResult(sessionKey: string, requestId: string) {
  const env = getEnv();
  const result = await env.TG_KV.get(
    `result:${sessionKey}:${requestId}`,
    "json",
  );
  return result || { pending: true as const };
}

export async function getPacketLog(
  sessionKey: string,
): Promise<ParsedPacketEntry[] | { error: "not_found" }> {
  const env = getEnv();
  const state = await loadSessionState(env, sessionKey);
  if (!state) {
    return { error: "not_found" as const };
  }
  return loadPacketLog(env, sessionKey);
}

export async function getConversations(
  sessionKey: string,
): Promise<ConversationCache | { error: "not_found" }> {
  const env = getEnv();
  const state = await loadSessionState(env, sessionKey);
  if (!state) {
    return { error: "not_found" as const };
  }
  return (
    await loadConversationCache(env, sessionKey)
  ) || { items: [], updatedAt: 0 };
}

export async function refreshConversations(sessionKey: string) {
  const env = getEnv();
  const requestId = crypto.randomUUID();
  return dispatchReadyRequest(
    env,
    sessionKey,
    {
      requestId,
      kind: "dialogs",
      method: "messages.GetDialogs",
    },
    (state) => buildGetDialogs(state, env.TELEGRAM_API_ID),
  );
}

export async function sendConversationMessage(
  sessionKey: string,
  conversationId: string,
  text: string,
) {
  const env = getEnv();
  const state = await loadSessionState(env, sessionKey);
  if (!state || state.state !== "READY") {
    return { error: "not_ready" as const };
  }

  const cache = await loadConversationCache(env, sessionKey);
  const conversation = cache?.items.find((item) => item.id === conversationId);
  if (!conversation) {
    return { error: "conversation_not_found" as const };
  }

  const requestId = crypto.randomUUID();
  return dispatchReadyRequest(
    env,
    sessionKey,
    {
      requestId,
      kind: "send_message",
      method: "messages.SendMessage",
    },
    (latestState) => buildSendMessage(
      latestState,
      env.TELEGRAM_API_ID,
      buildInputPeerFromConversation(conversation),
      text.trim(),
    ),
  );
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
