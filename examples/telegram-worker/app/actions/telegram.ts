"use server";

import { cookies } from "next/headers";
import { env as cfEnv } from "cloudflare:workers";
import {
  createSession,
  closeSession,
} from "../../worker/bridge-client";
import { normalizeUrl, resolveBridgeUrl } from "../../worker/bridge-url";
import {
  persistStateAndSend,
  sendBridgeBytes,
} from "../../worker/bridge-session";
import {
  cleanupSocket,
  isSocketGoneError,
  markSocketState,
  probeBridgeSocket,
} from "../../worker/socket-health";
import {
  Api,
  randomLong,
  beginAuthSession,
  submitAuthCode,
  submitAuthPassword,
  refreshQrLogin,
  sendApiMethod,
} from "gramjs-statemachine";
import type { ApiMethodPath, SerializedState } from "gramjs-statemachine";
import { buildInputPeerFromConversation } from "../../worker/inbound";
import {
  clearRuntimeArtifacts,
  loadConversationCache,
  loadPacketLog,
  trackPendingRequest,
} from "../../worker/runtime-store";
import {
  SESSION_COOKIE_NAME,
  decryptCookieValue,
  deleteCallbackBinding,
  deletePersistedSessionArtifacts,
  deleteSession,
  encryptCookieValue,
  loadBoth,
  loadBridgeSession,
  loadPersistedLink,
  loadPersistedSession,
  loadSerializedState,
  rebuildSessionFromPersisted,
  saveBridgeSession,
  saveCallbackBinding,
  saveSerializedState,
  shouldReuseRuntimeSession,
} from "../../worker/session-store";
import type {
  BridgeSession,
  BridgeSocketHealth,
  ConversationCache,
  Env,
  ParsedPacketEntry,
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

function toStatusPayload(state: SerializedState, bridge: BridgeSession) {
  return {
    state: state.phase,
    phase: state.phase,
    authMode: state.authMode,
    phone: state.phone,
    phoneCodeHash: state.phoneCodeHash,
    phoneCodeLength: state.phoneCodeLength,
    passwordHint: state.passwordHint,
    qrLoginUrl: state.qrLoginUrl,
    qrExpiresAt: state.qrExpiresAt,
    sessionRef: bridge.persistedSessionRef,
    user: state.user,
    error: state.error?.message,
    socketStatus: bridge.socketStatus,
    socketLastCheckedAt: bridge.socketLastCheckedAt,
    socketLastHealthyAt: bridge.socketLastHealthyAt,
  };
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
  const normalizedWorkerUrl = normalizeUrl(input.workerUrl || "");
  const sessionKey = crypto.randomUUID();
  const callbackKey = crypto.randomUUID();
  const initial = await beginAuthSession({
    apiId: env.TELEGRAM_API_ID,
    apiHash: env.TELEGRAM_API_HASH,
    dcMode,
    authMode,
    phone: authMode === "phone" ? input.phone : undefined,
  });
  const resolvedDc = initial.targetDc;

  // Create bridge socket
  const bridgeResp = await createSession(
    resolvedBridgeUrl,
    `mtproto-frame://${resolvedDc.ip}:${resolvedDc.port}`,
    `${normalizedWorkerUrl}/cb/${callbackKey}`,
  );
  console.debug('[telegram.startAuth] initial DH request ready', {
    sessionKey,
    authMode,
    dcMode,
    dcId: resolvedDc.id,
    target: `${resolvedDc.ip}:${resolvedDc.port}`,
    outboundLength: initial.outbound.length,
    nextPhase: initial.nextState.phase,
  });

  const bridge: BridgeSession = {
    sessionKey,
    callbackKey,
    socketId: bridgeResp.socket_id,
    bridgeUrl: resolvedBridgeUrl,
    socketStatus: "unknown",
  };

  // Persist state + bridge + callback binding
  await Promise.all([
    saveSerializedState(env, sessionKey, initial.nextState),
    saveBridgeSession(env, sessionKey, bridge),
    saveCallbackBinding(env, callbackKey, sessionKey),
  ]);

  // Send PQ request
  await sendBridgeBytes(env, sessionKey, bridge, initial.outbound);

  return {
    sessionKey,
    ...toStatusPayload(initial.nextState, bridge),
  };
}

export async function getStatus(sessionKey: string) {
  const env = getEnv();
  const loaded = await loadBoth(env, sessionKey);
  if (!loaded) {
    return { error: "not_found" as const };
  }
  const { state, bridge } = loaded;
  if (state.phase === "READY" && bridge.persistedSessionRef) {
    await writePersistedSessionCookie(env, bridge.persistedSessionRef);
  }
  return toStatusPayload(state, bridge);
}

export async function submitCode(sessionKey: string, code: string) {
  const env = getEnv();
  const loaded = await loadBoth(env, sessionKey);
  if (!loaded) {
    return { error: "not_found" as const };
  }
  const { state, bridge } = loaded;
  if (state.phase !== "AWAITING_CODE") {
    return { error: "invalid_state" as const };
  }

  const result = await submitAuthCode(state, code);
  await persistStateAndSend(
    env,
    sessionKey,
    bridge,
    result.nextState,
    result.outbound!,
  );

  return { phase: result.nextState.phase };
}

export async function submitPassword(sessionKey: string, password: string) {
  const env = getEnv();
  const loaded = await loadBoth(env, sessionKey);
  if (!loaded) {
    return { error: "not_found" as const };
  }
  const { state, bridge } = loaded;
  if (state.phase !== "AWAITING_PASSWORD") {
    return { error: "invalid_state" as const };
  }

  const result = await submitAuthPassword(state, password);
  await persistStateAndSend(
    env,
    sessionKey,
    bridge,
    result.nextState,
    result.outbound!,
  );

  return { phase: result.nextState.phase };
}

export async function refreshQrToken(sessionKey: string) {
  const env = getEnv();
  const loaded = await loadBoth(env, sessionKey);
  if (!loaded) {
    return { error: "not_found" as const };
  }
  const { state, bridge } = loaded;
  if (
    state.phase !== "AWAITING_QR_SCAN" &&
    state.phase !== "QR_TOKEN_SENT" &&
    state.phase !== "QR_IMPORT_SENT"
  ) {
    return { error: "invalid_state" as const };
  }

  const result = await refreshQrLogin(state);
  await persistStateAndSend(
    env,
    sessionKey,
    bridge,
    result.nextState,
    result.outbound!,
  );

  return { phase: result.nextState.phase };
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
    const liveBridge = await loadBridgeSession(env, link.liveSessionKey);
    const liveState = await loadSerializedState(env, link.liveSessionKey);
    if (liveBridge) {
      const health = await probeBridgeSocket(env, link.liveSessionKey, liveBridge);
      if (shouldReuseRuntimeSession(liveBridge, health.status)) {
        await writePersistedSessionCookie(env, persistedSessionRef);
        const refreshedBridge = await loadBridgeSession(env, link.liveSessionKey);
        const refreshedState = await loadSerializedState(env, link.liveSessionKey);
        const b = refreshedBridge || liveBridge;
        const s = refreshedState || liveState;
        if (s) {
          return {
            restored: true as const,
            sessionKey: link.liveSessionKey,
            health,
            ...toStatusPayload(s, b),
          };
        }
      }
    }

    // Stale — clean up the live session
    if (link.socketId) {
      await cleanupSocket(link.bridgeUrl, link.socketId);
    }
    if (liveBridge?.callbackKey) {
      await deleteCallbackBinding(env, liveBridge.callbackKey);
    }
    await deleteSession(env, link.liveSessionKey);
    await clearRuntimeArtifacts(env, link.liveSessionKey);
  }

  const rebuilt = await rebuildSessionFromPersisted(
    env,
    normalizeUrl(workerUrl || ""),
    persisted,
    bridgeUrl,
  );
  const health = await probeBridgeSocket(env, rebuilt.sessionKey, rebuilt.bridge);
  await writePersistedSessionCookie(env, persistedSessionRef);
  const restoredBridge = await loadBridgeSession(env, rebuilt.sessionKey) || rebuilt.bridge;
  const restoredState = await loadSerializedState(env, rebuilt.sessionKey) || rebuilt.state;
  return {
    restored: true as const,
    sessionKey: rebuilt.sessionKey,
    health,
    ...toStatusPayload(restoredState, restoredBridge),
  };
}

export async function logoutSession(sessionKey?: string) {
  const env = getEnv();
  let persistedSessionRef = await readPersistedSessionRefFromCookie(env);
  let activeBridge: BridgeSession | null = null;

  if (sessionKey) {
    activeBridge = await loadBridgeSession(env, sessionKey);
    persistedSessionRef = activeBridge?.persistedSessionRef || persistedSessionRef;
  }

  if (activeBridge?.socketId && activeBridge.bridgeUrl) {
    await cleanupSocket(activeBridge.bridgeUrl, activeBridge.socketId);
  }

  if (sessionKey) {
    await deleteCallbackBinding(env, activeBridge?.callbackKey);
    await deleteSession(env, sessionKey);
    await clearRuntimeArtifacts(env, sessionKey);
  }

  if (persistedSessionRef) {
    const link = await loadPersistedLink(env, persistedSessionRef);
    if (link?.socketId) {
      await cleanupSocket(link.bridgeUrl, link.socketId);
    }
    if (link?.liveSessionKey && link.liveSessionKey !== sessionKey) {
      const linkedBridge = await loadBridgeSession(env, link.liveSessionKey);
      await deleteCallbackBinding(env, linkedBridge?.callbackKey);
      await deleteSession(env, link.liveSessionKey);
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
  const bridge = await loadBridgeSession(env, sessionKey);
  if (!bridge) {
    return { error: "not_found" as const };
  }
  return probeBridgeSocket(env, sessionKey, bridge);
}

export async function sendTelegramMethod(
  sessionKey: string,
  method: string,
  params: Record<string, unknown>,
) {
  const env = getEnv();
  const loaded = await loadBoth(env, sessionKey);
  if (!loaded || loaded.state.phase !== "READY") {
    return { error: "not_ready" as const };
  }
  const { state, bridge } = loaded;

  // Build the API call using gramjs-statemachine
  const requestId = crypto.randomUUID();
  let result;
  try {
    result = await sendApiMethod(
      state,
      method as ApiMethodPath,
      params as never,
    );
  } catch (error) {
    if (isUnknownApiMethodError(error)) {
      return { error: "unknown_method" as const };
    }
    throw error;
  }
  if (!result) {
    return { error: "unknown_method" as const };
  }
  const msgId = result.nextState.lastMsgId;

  await persistStateAndSend(
    env,
    sessionKey,
    bridge,
    result.nextState,
    result.outbound!,
    [
      trackPendingRequest(env, sessionKey, msgId, {
        requestId,
        kind: "generic",
        method,
        createdAt: Date.now(),
      }),
    ],
  );

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

export async function getPacketLog(
  sessionKey: string,
): Promise<ParsedPacketEntry[] | { error: "not_found" }> {
  const env = getEnv();
  const bridge = await loadBridgeSession(env, sessionKey);
  if (!bridge) {
    return { error: "not_found" as const };
  }
  return loadPacketLog(env, sessionKey);
}

export async function getConversations(
  sessionKey: string,
): Promise<ConversationCache | { error: "not_found" }> {
  const env = getEnv();
  const bridge = await loadBridgeSession(env, sessionKey);
  if (!bridge) {
    return { error: "not_found" as const };
  }
  return (await loadConversationCache(env, sessionKey)) || { items: [], updatedAt: 0 };
}

export async function refreshConversations(sessionKey: string) {
  const env = getEnv();
  const loaded = await loadBoth(env, sessionKey);
  if (!loaded || loaded.state.phase !== "READY") {
    return { error: "not_ready" as const };
  }
  const { state, bridge } = loaded;

  const requestId = crypto.randomUUID();
  const result = await sendApiMethod(
    state,
    "messages.GetDialogs",
    {
      offsetDate: 0,
      offsetId: 0,
      offsetPeer: new Api.InputPeerEmpty(),
      limit: 20,
      hash: 0n,
    },
  );
  const msgId = result.nextState.lastMsgId;

  await persistStateAndSend(
    env,
    sessionKey,
    bridge,
    result.nextState,
    result.outbound!,
    [
      trackPendingRequest(env, sessionKey, msgId, {
        requestId,
        kind: "dialogs",
        method: "messages.GetDialogs",
        createdAt: Date.now(),
      }),
    ],
  );

  return { requestId };
}

export async function sendConversationMessage(
  sessionKey: string,
  conversationId: string,
  text: string,
) {
  const env = getEnv();
  const loaded = await loadBoth(env, sessionKey);
  if (!loaded || loaded.state.phase !== "READY") {
    return { error: "not_ready" as const };
  }
  const { state, bridge } = loaded;

  const cache = await loadConversationCache(env, sessionKey);
  const conversation = cache?.items.find((item) => item.id === conversationId);
  if (!conversation) {
    return { error: "conversation_not_found" as const };
  }

  const requestId = crypto.randomUUID();
  const inputPeer = buildInputPeerFromConversation(conversation);
  const result = await sendApiMethod(
    state,
    "messages.SendMessage",
    {
      peer: inputPeer,
      message: text.trim(),
      randomId: await randomLong(),
      noWebpage: true,
    },
  );
  const msgId = result.nextState.lastMsgId;

  await persistStateAndSend(
    env,
    sessionKey,
    bridge,
    result.nextState,
    result.outbound!,
    [
      trackPendingRequest(env, sessionKey, msgId, {
        requestId,
        kind: "send_message",
        method: "messages.SendMessage",
        createdAt: Date.now(),
      }),
    ],
  );

  return { requestId };
}

export async function closeCurrentSocket(sessionKey: string) {
  const env = getEnv();
  const bridge = await loadBridgeSession(env, sessionKey);
  if (!bridge) {
    return { error: "not_found" as const };
  }

  try {
    await closeSession(resolveBridgeUrl(bridge.bridgeUrl), bridge.socketId);
  } catch (error) {
    if (!isSocketGoneError(error)) {
      throw error;
    }
  }
  await markSocketState(env, sessionKey, "closed", "socket closed by user");
  return { ok: true as const };
}

function isUnknownApiMethodError(error: unknown): boolean {
  return error instanceof Error
    && (error.message.startsWith("Unknown API method:")
      || error.message.startsWith("API path is not a request:"));
}
