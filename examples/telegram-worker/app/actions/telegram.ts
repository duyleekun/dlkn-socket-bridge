"use server";

import { cookies } from "next/headers";
import { env as cfEnv } from "cloudflare:workers";
import {
  createSession as createBridgeSession,
  closeSession,
} from "../../worker/bridge-client";
import { normalizeUrl, resolveBridgeUrl } from "../../worker/bridge-url";
import {
  executeSessionCommands,
  persistStateAndExecute,
} from "../../worker/bridge-session";
import {
  cleanupSocket,
  isSocketGoneError,
  markSocketState,
  probeBridgeSocket,
} from "../../worker/socket-health";
import {
  buildTelegramGetDifferenceParams,
  invokeSessionMethod,
  createSession as createTelegramSession,
  selectSessionView,
  transitionSession,
} from "gramjs-statemachine";
import type { ApiMethodPath, SessionSnapshot } from "gramjs-statemachine";
import {
  clearRuntimeArtifacts,
  loadPacketLog,
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
  loadPersistedSession,
  loadSerializedState,
  rebuildSessionFromPersisted,
  saveBridgeSession,
  saveCallbackBinding,
  saveSerializedState,
} from "../../worker/session-store";
import type {
  BridgeSession,
  BridgeSocketHealth,
  Env,
  ParsedPacketEntry,
  TelegramAuthMode,
  TelegramDcMode,
  TelegramUpdatesState,
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

async function toStatusPayload(
  env: Env,
  sessionKey: string,
  state: SessionSnapshot,
  bridge: BridgeSession,
) {
  const view = selectSessionView(state);
  return {
    view,
    sessionRef: bridge.persistedSessionRef,
    socketStatus: bridge.socketStatus,
    socketLastCheckedAt: bridge.socketLastCheckedAt,
    socketLastHealthyAt: bridge.socketLastHealthyAt,
    updatesState: bridge.updatesState ?? null,
  };
}

async function loadStatusPayload(
  env: Env,
  sessionKey: string,
) {
  const loaded = await loadBoth(env, sessionKey);
  if (!loaded) {
    return null;
  }
  return toStatusPayload(env, sessionKey, loaded.state, loaded.bridge);
}

async function waitForUpdatesStateChange(
  env: Env,
  sessionKey: string,
  previousUpdatedAt: number,
  timeoutMs = 3000,
): Promise<TelegramUpdatesState | null> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const updatesState = (await loadBridgeSession(env, sessionKey))?.updatesState ?? null;
    if (updatesState && updatesState.updatedAt > previousUpdatedAt) {
      return updatesState;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return (await loadBridgeSession(env, sessionKey))?.updatesState ?? null;
}

async function invokeReadySessionMethod(
  env: Env,
  sessionKey: string,
  method: ApiMethodPath,
  params: Record<string, unknown> | undefined,
) {
  const loaded = await loadBoth(env, sessionKey);
  if (!loaded || loaded.state.value !== "ready") {
    return { error: "not_ready" as const };
  }
  const { state, bridge } = loaded;
  const beforeUpdatedAt = bridge.updatesState?.updatedAt ?? 0;

  const result = await invokeSessionMethod(
    state,
    method,
    params as never,
  );
  const msgId = result.snapshot.context.lastMsgId;
  await persistStateAndExecute(
    env,
    "",
    sessionKey,
    bridge,
    result.snapshot,
    result.commands,
  );

  const updatesState = await waitForUpdatesStateChange(
    env,
    sessionKey,
    beforeUpdatedAt,
  );
  const status = await loadStatusPayload(env, sessionKey);
  if (!status) {
    return { error: "not_found" as const };
  }

  return {
    ok: true as const,
    msgId,
    status,
    updatesState,
    updated: Boolean(updatesState && updatesState.updatedAt > beforeUpdatedAt),
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
  const initial = await createTelegramSession({
    apiId: env.TELEGRAM_API_ID,
    apiHash: env.TELEGRAM_API_HASH,
    dcMode,
    authMode,
    phone: authMode === "phone" ? input.phone : undefined,
  });

  const bridgeResp = await createBridgeSession(
    resolvedBridgeUrl,
    `mtproto-frame://${initial.snapshot.context.dcIp}:${initial.snapshot.context.dcPort}`,
    `${normalizedWorkerUrl}/cb/${callbackKey}`,
  );

  const bridge: BridgeSession = {
    sessionKey,
    callbackKey,
    socketId: bridgeResp.socket_id,
    bridgeUrl: resolvedBridgeUrl,
    socketStatus: "unknown",
  };

  await Promise.all([
    saveSerializedState(env, sessionKey, initial.snapshot),
    saveBridgeSession(env, sessionKey, bridge),
    saveCallbackBinding(env, callbackKey, sessionKey),
  ]);

  await executeSessionCommands(
    env,
    normalizedWorkerUrl,
    sessionKey,
    bridge,
    initial.commands,
  );

  return {
    sessionKey,
    ...(await toStatusPayload(env, sessionKey, initial.snapshot, bridge)),
  };
}

export async function getStatus(sessionKey: string) {
  const env = getEnv();
  const loaded = await loadBoth(env, sessionKey);
  if (!loaded) {
    return { error: "not_found" as const };
  }
  const { state, bridge } = loaded;
  if (state.value === "ready" && bridge.persistedSessionRef) {
    await writePersistedSessionCookie(env, bridge.persistedSessionRef);
  }
  return toStatusPayload(env, sessionKey, state, bridge);
}

export async function submitCode(sessionKey: string, code: string) {
  const env = getEnv();
  const loaded = await loadBoth(env, sessionKey);
  if (!loaded) {
    return { error: "not_found" as const };
  }
  const { state, bridge } = loaded;
  if (state.value !== "awaiting_code") {
    return { error: "invalid_state" as const };
  }

  const result = await transitionSession(state, {
    type: "submit_code",
    code,
  });
  await persistStateAndExecute(
    env,
    "",
    sessionKey,
    bridge,
    result.snapshot,
    result.commands,
  );

  return toStatusPayload(env, sessionKey, result.snapshot, bridge);
}

export async function submitPassword(sessionKey: string, password: string) {
  const env = getEnv();
  const loaded = await loadBoth(env, sessionKey);
  if (!loaded) {
    return { error: "not_found" as const };
  }
  const { state, bridge } = loaded;
  if (state.value !== "awaiting_password") {
    return { error: "invalid_state" as const };
  }

  const result = await transitionSession(state, {
    type: "submit_password",
    password,
  });
  await persistStateAndExecute(
    env,
    "",
    sessionKey,
    bridge,
    result.snapshot,
    result.commands,
  );

  return toStatusPayload(env, sessionKey, result.snapshot, bridge);
}

export async function refreshQrToken(sessionKey: string) {
  const env = getEnv();
  const loaded = await loadBoth(env, sessionKey);
  if (!loaded) {
    return { error: "not_found" as const };
  }
  const { state, bridge } = loaded;
  if (!selectSessionView(state).canRefreshQr) {
    return { error: "invalid_state" as const };
  }

  const result = await transitionSession(state, {
    type: "refresh_qr",
  });
  await persistStateAndExecute(
    env,
    "",
    sessionKey,
    bridge,
    result.snapshot,
    result.commands,
  );

  return toStatusPayload(env, sessionKey, result.snapshot, bridge);
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

  const rebuilt = await rebuildSessionFromPersisted(
    env,
    normalizeUrl(workerUrl || ""),
    persisted,
    bridgeUrl,
  );
  const bootstrap = await invokeSessionMethod(
    rebuilt.state,
    "help.GetConfig",
    undefined as never,
  );
  await persistStateAndExecute(
    env,
    "",
    rebuilt.sessionKey,
    rebuilt.bridge,
    bootstrap.snapshot,
    bootstrap.commands,
  );
  const health = await probeBridgeSocket(env, rebuilt.sessionKey, rebuilt.bridge);
  await writePersistedSessionCookie(env, persistedSessionRef);
  const restoredBridge = await loadBridgeSession(env, rebuilt.sessionKey) || rebuilt.bridge;
  const restoredState = await loadSerializedState(env, rebuilt.sessionKey) || bootstrap.snapshot;
  return {
    restored: true as const,
    sessionKey: rebuilt.sessionKey,
    health,
    ...(await toStatusPayload(
      env,
      rebuilt.sessionKey,
      restoredState,
      restoredBridge,
    )),
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

export async function getTelegramUpdatesState(
  sessionKey: string,
): Promise<TelegramUpdatesState | { error: "not_found" }> {
  const env = getEnv();
  const bridge = await loadBridgeSession(env, sessionKey);
  if (!bridge) {
    return { error: "not_found" as const };
  }
  return bridge.updatesState || {
    error: "not_found" as const,
  };
}

export async function telegramGetState(sessionKey: string) {
  const env = getEnv();
  return invokeReadySessionMethod(
    env,
    sessionKey,
    "updates.GetState",
    undefined,
  );
}

export async function telegramGetDifference(sessionKey: string) {
  const env = getEnv();
  const loaded = await loadBoth(env, sessionKey);
  if (!loaded || loaded.state.value !== "ready") {
    return { error: "not_ready" as const };
  }
  const updatesState = loaded.bridge.updatesState;
  if (!updatesState) {
    return { error: "missing_updates_state" as const };
  }
  return invokeReadySessionMethod(
    env,
    sessionKey,
    "updates.GetDifference",
    buildTelegramGetDifferenceParams(updatesState),
  );
}

export async function sendTelegramMethod(
  sessionKey: string,
  method: string,
  params: Record<string, unknown>,
) {
  const env = getEnv();
  const loaded = await loadBoth(env, sessionKey);
  if (!loaded || loaded.state.value !== "ready") {
    return { error: "not_ready" as const };
  }
  const { state, bridge } = loaded;

  let result;
  try {
    result = await invokeSessionMethod(
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

  const msgId = result.snapshot.context.lastMsgId;
  await persistStateAndExecute(
    env,
    "",
    sessionKey,
    bridge,
    result.snapshot,
    result.commands,
  );

  return { ok: true as const, msgId };
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
