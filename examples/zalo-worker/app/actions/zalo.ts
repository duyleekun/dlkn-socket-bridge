"use server";

import { ThreadType } from "zca-js";
import { cookies } from "next/headers";
import { env as cfEnv } from "cloudflare:workers";
import type {
  Env,
  ZaloMessage,
  BridgeSession,
  SocketStatus,
  SocketActivityEntry,
} from "../../worker/types";
import { normalizeUrl } from "../../worker/bridge-url";
import { executeSessionCommands } from "../../worker/bridge-session";
import { probeBridgeSocket, markSocketState } from "../../worker/socket-health";
import {
  SESSION_COOKIE_NAME,
  encryptCookieValue,
  decryptCookieValue,
  loadSerializedState,
  saveSerializedState,
  loadBridgeSession,
  saveBridgeSession,
  loadBoth,
  saveCallbackBinding,
  loadPersistedSession,
  savePersistedSession,
  loadPersistedLink,
  clearRuntimeArtifacts,
  deleteSession,
  deletePersistedSessionArtifacts,
  deleteCallbackBinding,
  rebuildSessionFromPersisted,
  shouldReuseRuntimeSession,
} from "../../worker/session-store";
import {
  createSession,
  transitionSession,
  selectSessionView,
  type SessionSnapshot,
  type ZaloSessionView,
} from "zca-js-statemachine";
import {
  loginWithCredentials,
  performQRLogin,
  resolveSelfThreadId,
  validatePersistedSession,
} from "../../worker/zalo-login";
import {
  buildRecoveryCommands,
  cloneRuntimeArtifacts,
  loadMessageLog,
  resolveMessageRecoveryCursor,
  loadSocketActivityLog,
} from "../../worker/runtime-store";
import { cleanupSocket } from "../../worker/socket-health";
import type { BridgeSocketHealth } from "../../worker/socket-health";

// ── Helpers ──────────────────────────────────────────────────────────────────

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
  if (!cookie) return null;
  return decryptCookieValue(env.ZALO_SESSION_COOKIE_SECRET, cookie);
}

async function writePersistedSessionCookie(
  env: Env,
  persistedSessionRef: string,
): Promise<void> {
  const store = await cookieStore();
  const encrypted = await encryptCookieValue(
    env.ZALO_SESSION_COOKIE_SECRET,
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

export interface StatusData {
  phase: string;
  view: ZaloSessionView;
  socketStatus: SocketStatus;
  socketLastCheckedAt?: number;
  sessionRef?: string;
}

function isRemoteLogoutMessage(message?: string | null): boolean {
  return (
    typeof message === "string" &&
    (
      message.includes("Zalo session ended remotely") ||
      message.includes("WebSocket closed: error (1000)")
    )
  );
}

function isWebSocketClosedMessage(message?: string | null): boolean {
  return (
    typeof message === "string" &&
    message.includes("WebSocket closed:")
  );
}

function toStatusPayload(state: SessionSnapshot, bridge: BridgeSession): StatusData {
  const remoteLogout = isRemoteLogoutMessage(state.context.errorMessage);
  const view = selectSessionView(state);
  const closedSocket = isWebSocketClosedMessage(state.context.errorMessage);
  return {
    phase: state.value,
    view: remoteLogout
      ? {
          ...view,
          errorMessage: "Zalo session ended remotely. Scan a new QR code to sign back in.",
        }
      : view,
    socketStatus: remoteLogout || closedSocket ? "closed" : bridge.socketStatus,
    socketLastCheckedAt: bridge.socketLastCheckedAt,
    sessionRef: remoteLogout ? undefined : bridge.persistedSessionRef,
  };
}

async function cleanupRuntimeSession(
  env: Env,
  sessionKey: string | undefined,
): Promise<void> {
  if (!sessionKey) return;
  const bridge = await loadBridgeSession(env, sessionKey);
  if (bridge?.socketId) {
    await cleanupSocket(bridge.bridgeUrl, bridge.socketId);
  }
  if (bridge?.callbackKey) {
    await deleteCallbackBinding(env, bridge.callbackKey);
  }
  await deleteSession(env, sessionKey);
}

async function invalidatePersistedRecovery(
  env: Env,
  persistedSessionRef: string,
  previousSessionKey?: string,
): Promise<void> {
  if (previousSessionKey) {
    await cleanupRuntimeSession(env, previousSessionKey);
    await clearRuntimeArtifacts(env, previousSessionKey);
  }
  await deletePersistedSessionArtifacts(env, persistedSessionRef);
  await clearPersistedSessionCookie();
}

async function rebuildRecoveredSession(
  env: Env,
  options: {
    persistedSessionRef: string;
    bridgeUrl?: string;
    workerUrl?: string;
    previousSessionKey?: string;
  },
) {
  const persisted = await loadPersistedSession(env, options.persistedSessionRef);
  if (!persisted) {
    return { ok: false as const, invalidPersisted: true };
  }

  const validated = await validatePersistedSession({
    credentials: persisted.credentials,
    userProfile: persisted.userProfile,
  });
  if (!validated.ok) {
    return {
      ok: false as const,
      invalidPersisted: true,
      error: validated.error,
    };
  }

  const refreshedPersisted = {
    ...persisted,
    credentials: validated.credentials,
    userProfile: validated.userProfile,
    wsUrl: validated.wsUrl,
    pingIntervalMs: validated.pingIntervalMs,
    updatedAt: Date.now(),
  };
  await savePersistedSession(env, refreshedPersisted);

  const rebuilt = await rebuildSessionFromPersisted(
    env,
    normalizeUrl(options.workerUrl || ""),
    refreshedPersisted,
    options.bridgeUrl,
  );

  const rebuiltBridge: BridgeSession = {
    ...rebuilt.bridge,
    pendingBacklogRecovery: true,
  };
  await saveBridgeSession(env, rebuilt.sessionKey, rebuiltBridge);

  if (
    options.previousSessionKey &&
    options.previousSessionKey !== rebuilt.sessionKey
  ) {
    await cloneRuntimeArtifacts(
      env,
      options.previousSessionKey,
      rebuilt.sessionKey,
    );
    await cleanupRuntimeSession(env, options.previousSessionKey);
    await clearRuntimeArtifacts(env, options.previousSessionKey);
  }

  const health = await probeBridgeSocket(env, rebuilt.sessionKey, rebuiltBridge);
  const restoredBridge =
    (await loadBridgeSession(env, rebuilt.sessionKey)) || rebuiltBridge;
  const restoredState =
    (await loadSerializedState(env, rebuilt.sessionKey)) || rebuilt.state;

  return {
    ok: true as const,
    sessionKey: rebuilt.sessionKey,
    bridge: restoredBridge,
    state: restoredState,
    health,
  };
}

// ── startAuth ────────────────────────────────────────────────────────────────

export async function startAuth(input: {
  bridgeUrl: string;
  workerUrl?: string;
}): Promise<{ sessionKey: string }> {
  const env = getEnv();
  const sessionKey = crypto.randomUUID();
  const callbackKey = crypto.randomUUID();

  const result = await createSession({
    mode: "qr",
    userAgent: "Mozilla/5.0",
    language: "vi",
  });

  const bridge: BridgeSession = {
    sessionKey,
    callbackKey,
    socketId: "",  // no socket yet — created after login
    bridgeUrl: normalizeUrl(input.bridgeUrl),
    socketStatus: "unknown",
  };

  await Promise.all([
    saveSerializedState(env, sessionKey, result.snapshot),
    saveBridgeSession(env, sessionKey, bridge),
    saveCallbackBinding(env, callbackKey, sessionKey),
  ]);

  return { sessionKey };
}

// ── initiateQRLogin ──────────────────────────────────────────────────────────

export async function initiateQRLogin(
  sessionKey: string,
  _bridgeUrl: string,
  workerUrl: string,
): Promise<{ success: boolean; error?: string }> {
  const env = getEnv();
  const state = await loadSerializedState(env, sessionKey);
  if (!state) return { success: false, error: "session not found" };

  try {
    const loginResult = await performQRLogin(
      state.context.userAgent || "Mozilla/5.0",
      state.context.language || "vi",
      async (qrImage: string) => {
        // QR code generated — transition state
        const currentState = await loadSerializedState(env, sessionKey);
        if (!currentState) return;
        const result = await transitionSession(currentState, {
          type: "http_login_qr_result",
          qrData: {
            image: qrImage,
            token: crypto.randomUUID(),
            expiresAt: Date.now() + 120000,
          },
        });
        await saveSerializedState(env, sessionKey, result.snapshot);
      },
      async (info) => {
        // QR scanned
        const currentState = await loadSerializedState(env, sessionKey);
        if (!currentState) return;
        const result = await transitionSession(currentState, {
          type: "qr_scan_event",
          event: "scanned",
          data: info,
        });
        await saveSerializedState(env, sessionKey, result.snapshot);
      },
    );

    // Login succeeded — transition with credentials
    const currentState = await loadSerializedState(env, sessionKey);
    if (!currentState) return { success: false, error: "session lost during login" };

    const result = await transitionSession(currentState, {
      type: "http_login_creds_result",
      credentials: loginResult.credentials,
      userProfile: loginResult.userProfile,
      wsUrl: loginResult.wsUrl,
      pingIntervalMs: loginResult.pingIntervalMs,
    });

    // Save state first
    await saveSerializedState(env, sessionKey, result.snapshot);

    const bridge = await loadBridgeSession(env, sessionKey);
    if (!bridge) return { success: false, error: "bridge session lost" };
    const normalizedWorkerUrl = normalizeUrl(workerUrl);

    // Execute any commands from the transition
    const updatedBridge = await executeSessionCommands(
      env,
      normalizedWorkerUrl,
      sessionKey,
      bridge,
      result.commands,
    );

    // Set cookie for session persistence
    if (!updatedBridge.persistedSessionRef) {
      return { success: false, error: "persisted session ref missing after login" };
    }
    await writePersistedSessionCookie(env, updatedBridge.persistedSessionRef);

    return { success: true };
  } catch (err) {
    // Transition to error state
    const currentState = await loadSerializedState(env, sessionKey);
    if (currentState) {
      const errorResult = await transitionSession(currentState, {
        type: "http_login_failed",
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      await saveSerializedState(env, sessionKey, errorResult.snapshot);
    }
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── getStatus ────────────────────────────────────────────────────────────────

export async function getStatus(sessionKey: string): Promise<StatusData | null> {
  const env = getEnv();
  const loaded = await loadBoth(env, sessionKey);
  if (!loaded) return null;
  const { state, bridge } = loaded;
  let nextBridge = bridge;

  if (state.value === "listening" && bridge.persistedSessionRef) {
    await writePersistedSessionCookie(env, bridge.persistedSessionRef);
  }

  if (isRemoteLogoutMessage(state.context.errorMessage)) {
    await clearPersistedSessionCookie();
    if (bridge.persistedSessionRef) {
      await deletePersistedSessionArtifacts(env, bridge.persistedSessionRef);
      nextBridge = {
        ...bridge,
        persistedSessionRef: undefined,
      };
      await saveBridgeSession(env, sessionKey, nextBridge);
    }
    const marked = await markSocketState(
      env,
      sessionKey,
      "closed",
      state.context.errorMessage ?? undefined,
    );
    if (marked) {
      nextBridge = marked;
    }
  }

  return toStatusPayload(state, nextBridge);
}

// ── getQRCode ────────────────────────────────────────────────────────────────

export async function getQRCode(
  sessionKey: string,
): Promise<{ qrImage: string; qrToken: string; expiresAt: number } | null> {
  const env = getEnv();
  const state = await loadSerializedState(env, sessionKey);
  if (!state || !state.context.qrData) return null;
  return {
    qrImage: state.context.qrData.image,
    qrToken: state.context.qrData.token,
    expiresAt: state.context.qrData.expiresAt,
  };
}

// ── checkSocketHealth ────────────────────────────────────────────────────────

export async function checkSocketHealth(
  sessionKey: string,
): Promise<BridgeSocketHealth | { error: "not_found" }> {
  const env = getEnv();
  const bridge = await loadBridgeSession(env, sessionKey);
  if (!bridge || !bridge.socketId) {
    return { error: "not_found" as const };
  }
  return probeBridgeSocket(env, sessionKey, bridge);
}

// ── restoreSessionFromCookie ─────────────────────────────────────────────────

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
  }

  const rebuilt = await rebuildRecoveredSession(env, {
    persistedSessionRef,
    bridgeUrl,
    workerUrl,
    previousSessionKey: link?.liveSessionKey,
  });
  if (!rebuilt.ok) {
    if (rebuilt.invalidPersisted) {
      await invalidatePersistedRecovery(
        env,
        persistedSessionRef,
        link?.liveSessionKey,
      );
    } else {
      await clearPersistedSessionCookie();
    }
    return { restored: false as const };
  }
  await writePersistedSessionCookie(env, persistedSessionRef);
  return {
    restored: true as const,
    sessionKey: rebuilt.sessionKey,
    health: rebuilt.health,
    ...toStatusPayload(rebuilt.state, rebuilt.bridge),
  };
}

// ── recoverBridgeSession ─────────────────────────────────────────────────────

export async function recoverBridgeSession(
  sessionKey: string,
  bridgeUrl?: string,
  workerUrl?: string,
) {
  const env = getEnv();
  const bridge = await loadBridgeSession(env, sessionKey);
  const persistedSessionRef =
    bridge?.persistedSessionRef || (await readPersistedSessionRefFromCookie(env));

  if (!persistedSessionRef) {
    await clearPersistedSessionCookie();
    return { restored: false as const };
  }

  const rebuilt = await rebuildRecoveredSession(env, {
    persistedSessionRef,
    bridgeUrl,
    workerUrl,
    previousSessionKey: sessionKey,
  });
  if (!rebuilt.ok) {
    if (rebuilt.invalidPersisted) {
      await invalidatePersistedRecovery(env, persistedSessionRef, sessionKey);
    } else {
      await clearPersistedSessionCookie();
    }
    return { restored: false as const };
  }

  await writePersistedSessionCookie(env, persistedSessionRef);
  return {
    restored: true as const,
    sessionKey: rebuilt.sessionKey,
    health: rebuilt.health,
    ...toStatusPayload(rebuilt.state, rebuilt.bridge),
  };
}

// ── logoutSession ────────────────────────────────────────────────────────────

export async function logoutSession(sessionKey?: string): Promise<{ ok: true }> {
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
  return { ok: true };
}

// ── sendZaloMessage ──────────────────────────────────────────────────────────

export async function sendZaloMessage(
  sessionKey: string,
  threadId: string,
  threadType: number,
  text: string,
): Promise<{ ok: boolean; messageId?: string; error?: string }> {
  const env = getEnv();
  const trimmedThreadId = threadId.trim();
  const trimmedText = text.trim();

  if (!sessionKey) {
    return { ok: false, error: "Session key is required." };
  }
  if (!trimmedThreadId) {
    return { ok: false, error: "Destination thread is required." };
  }
  if (!trimmedText) {
    return { ok: false, error: "Message text is required." };
  }

  const bridge = await loadBridgeSession(env, sessionKey);
  const persistedSessionRef =
    bridge?.persistedSessionRef || (await readPersistedSessionRefFromCookie(env));
  if (!persistedSessionRef) {
    return { ok: false, error: "No persisted Zalo session is available for sending." };
  }

  const persisted = await loadPersistedSession(env, persistedSessionRef);
  if (!persisted) {
    return { ok: false, error: "Persisted Zalo session could not be restored." };
  }

  try {
    const api = await loginWithCredentials(persisted.credentials);
    const selfThreadId = resolveSelfThreadId(api);
    const isSelfTarget =
      threadType !== ThreadType.Group &&
      trimmedThreadId === persisted.userProfile?.uid;
    if (isSelfTarget && !selfThreadId) {
      return {
        ok: false,
        error: "Authenticated session did not expose a self-send target.",
      };
    }
    const targetThreadId = isSelfTarget ? (selfThreadId as string) : trimmedThreadId;
    const response = await api.sendMessage(
      trimmedText,
      targetThreadId,
      threadType === ThreadType.Group ? ThreadType.Group : ThreadType.User,
    );

    const messageId =
      response.message?.msgId != null
        ? String(response.message.msgId)
        : `local-${Date.now()}`;

    return { ok: true, messageId };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ── getMessageLog ────────────────────────────────────────────────────────────

export async function getMessageLog(sessionKey: string): Promise<ZaloMessage[]> {
  const env = getEnv();
  return loadMessageLog(env, sessionKey);
}

export async function getSocketActivityLog(
  sessionKey: string,
): Promise<SocketActivityEntry[]> {
  const env = getEnv();
  return loadSocketActivityLog(env, sessionKey);
}

export async function fetchMissingZaloEvents(
  sessionKey: string,
): Promise<{
  ok: boolean;
  error?: string;
  requestedDm: boolean;
  requestedGroup: boolean;
}> {
  const env = getEnv();
  if (!sessionKey) {
    return {
      ok: false,
      error: "Session key is required.",
      requestedDm: false,
      requestedGroup: false,
    };
  }

  const loaded = await loadBoth(env, sessionKey);
  if (!loaded) {
    return {
      ok: false,
      error: "Session not found.",
      requestedDm: false,
      requestedGroup: false,
    };
  }

  if (loaded.state.value !== "listening") {
    return {
      ok: false,
      error: "Realtime socket is not ready yet.",
      requestedDm: false,
      requestedGroup: false,
    };
  }

  const cursor = await resolveMessageRecoveryCursor(env, sessionKey);
  const commands = buildRecoveryCommands(cursor);

  if (commands.length === 0) {
    return {
      ok: false,
      error: "No DM or group recovery cursor is available yet.",
      requestedDm: false,
      requestedGroup: false,
    };
  }

  try {
    await executeSessionCommands(
      env,
      normalizeUrl(env.WORKER_URL),
      sessionKey,
      loaded.bridge,
      commands,
    );
    return {
      ok: true,
      requestedDm: Boolean(cursor.lastUserMessageId),
      requestedGroup: Boolean(cursor.lastGroupMessageId),
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      requestedDm: false,
      requestedGroup: false,
    };
  }
}
