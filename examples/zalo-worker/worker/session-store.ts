import { createSession } from "./bridge-client";
import { normalizeUrl, resolveBridgeUrl } from "./bridge-url";
import type {
  BridgeSession,
  Env,
  PersistedSessionLink,
  PersistedZaloSession,
  SocketStatus,
} from "./types";
import {
  buildZaloWsHeaders,
  type SessionSnapshot,
} from "zca-js-statemachine";

export const SESSION_COOKIE_NAME = "zalo_session_ref";

// ── KV key helpers ────────────────────────────────────────────────────────────

function serializedStateKey(sessionKey: string): string {
  return `zalo-sm-state:${sessionKey}`;
}

function bridgeSessionKey(sessionKey: string): string {
  return `zalo-bridge-session:${sessionKey}`;
}

function callbackBindingKey(callbackKey: string): string {
  return `zalo-callback:${callbackKey}`;
}

function persistedSessionKey(persistedSessionRef: string): string {
  return `zalo-persisted:${persistedSessionRef}`;
}

function persistedLinkKey(persistedSessionRef: string): string {
  return `zalo-persisted-link:${persistedSessionRef}`;
}

// ── In-memory caches (warm for a single Worker instance lifetime) ─────────────

const serializedStateCache = new Map<string, SessionSnapshot>();
const bridgeSessionCache = new Map<string, BridgeSession>();

// ── State I/O ─────────────────────────────────────────────────────────────────

export async function loadSerializedState(
  env: Env,
  sessionKey: string,
): Promise<SessionSnapshot | null> {
  const cached = serializedStateCache.get(sessionKey);
  if (cached) return cached;
  const state = await env.ZALO_KV.get<SessionSnapshot>(serializedStateKey(sessionKey), "json");
  if (state) serializedStateCache.set(sessionKey, state);
  return state;
}

export async function saveSerializedState(
  env: Env,
  sessionKey: string,
  state: SessionSnapshot,
): Promise<void> {
  serializedStateCache.set(sessionKey, state);
  await env.ZALO_KV.put(serializedStateKey(sessionKey), JSON.stringify(state));
}

export async function loadBridgeSession(
  env: Env,
  sessionKey: string,
): Promise<BridgeSession | null> {
  const cached = bridgeSessionCache.get(sessionKey);
  if (cached) return cached;
  const bridge = await env.ZALO_KV.get<BridgeSession>(bridgeSessionKey(sessionKey), "json");
  if (bridge) bridgeSessionCache.set(sessionKey, bridge);
  return bridge;
}

export async function saveBridgeSession(
  env: Env,
  sessionKey: string,
  bridge: BridgeSession,
): Promise<void> {
  bridgeSessionCache.set(sessionKey, bridge);
  await env.ZALO_KV.put(bridgeSessionKey(sessionKey), JSON.stringify(bridge));
}

export async function loadBoth(
  env: Env,
  sessionKey: string,
): Promise<{ state: SessionSnapshot; bridge: BridgeSession } | null> {
  const [state, bridge] = await Promise.all([
    loadSerializedState(env, sessionKey),
    loadBridgeSession(env, sessionKey),
  ]);
  if (!state || !bridge) return null;
  return { state, bridge };
}

// ── Callback binding ──────────────────────────────────────────────────────────

export async function loadSessionKeyByCallbackKey(
  env: Env,
  callbackKey: string,
): Promise<string | null> {
  return env.ZALO_KV.get(callbackBindingKey(callbackKey));
}

export async function saveCallbackBinding(
  env: Env,
  callbackKey: string,
  sessionKey: string,
): Promise<void> {
  await env.ZALO_KV.put(callbackBindingKey(callbackKey), sessionKey);
}

export async function deleteCallbackBinding(
  env: Env,
  callbackKey: string | undefined,
): Promise<void> {
  if (!callbackKey) return;
  await env.ZALO_KV.delete(callbackBindingKey(callbackKey));
}

// ── Session lifecycle ─────────────────────────────────────────────────────────

/** Delete both sm-state and bridge-session KV entries for a session. */
export async function deleteSession(
  env: Env,
  sessionKey: string,
): Promise<void> {
  serializedStateCache.delete(sessionKey);
  bridgeSessionCache.delete(sessionKey);
  await Promise.all([
    env.ZALO_KV.delete(serializedStateKey(sessionKey)),
    env.ZALO_KV.delete(bridgeSessionKey(sessionKey)),
  ]);
}

export function shouldReuseRuntimeSession(
  bridge: BridgeSession | null,
  socketStatus: SocketStatus,
): boolean {
  return Boolean(bridge) && socketStatus === "healthy";
}

// ── Persisted sessions ────────────────────────────────────────────────────────

export async function loadPersistedSession(
  env: Env,
  persistedSessionRef: string,
): Promise<PersistedZaloSession | null> {
  return env.ZALO_KV.get<PersistedZaloSession>(
    persistedSessionKey(persistedSessionRef),
    "json",
  );
}

export async function savePersistedSession(
  env: Env,
  record: PersistedZaloSession,
): Promise<void> {
  await env.ZALO_KV.put(
    persistedSessionKey(record.persistedSessionRef),
    JSON.stringify(record),
  );
}

export async function loadPersistedLink(
  env: Env,
  persistedSessionRef: string,
): Promise<PersistedSessionLink | null> {
  return env.ZALO_KV.get<PersistedSessionLink>(
    persistedLinkKey(persistedSessionRef),
    "json",
  );
}

export async function savePersistedLink(
  env: Env,
  record: PersistedSessionLink,
): Promise<void> {
  await env.ZALO_KV.put(
    persistedLinkKey(record.persistedSessionRef),
    JSON.stringify(record),
  );
}

export async function deletePersistedSessionArtifacts(
  env: Env,
  persistedSessionRef: string,
): Promise<void> {
  await Promise.all([
    env.ZALO_KV.delete(persistedSessionKey(persistedSessionRef)),
    env.ZALO_KV.delete(persistedLinkKey(persistedSessionRef)),
  ]);
}

/**
 * Update the persisted link from bridge metadata and a socket health status.
 */
export async function updatePersistedLinkFromBridge(
  env: Env,
  sessionKey: string,
  bridge: BridgeSession,
  socketHealth: SocketStatus = bridge.socketStatus,
): Promise<void> {
  if (!bridge.persistedSessionRef) return;
  await savePersistedLink(env, {
    persistedSessionRef: bridge.persistedSessionRef,
    liveSessionKey: sessionKey,
    socketId: bridge.socketId,
    bridgeUrl: resolveBridgeUrl(bridge.bridgeUrl),
    updatedAt: Date.now(),
    socketHealth,
  });
}

/**
 * Rebuild a new SessionSnapshot + BridgeSession from a persisted Zalo session record.
 * Used when resuming an existing authenticated session (cookie restore).
 */
export async function rebuildSessionFromPersisted(
  env: Env,
  workerUrl: string,
  persisted: PersistedZaloSession,
  bridgeUrl?: string,
): Promise<{ sessionKey: string; state: SessionSnapshot; bridge: BridgeSession }> {
  const sessionKey = crypto.randomUUID();
  const callbackKey = crypto.randomUUID();
  const normalizedWorkerUrl = normalizeUrl(workerUrl);
  const resolvedBridgeUrl = resolveBridgeUrl(bridgeUrl);
  const bridgeResp = await createSession(
    resolvedBridgeUrl,
    persisted.wsUrl,
    `${normalizedWorkerUrl}/cb/${callbackKey}`,
    { headers: buildZaloWsHeaders(persisted.credentials, persisted.wsUrl) },
  );

  const state: SessionSnapshot = {
    version: 1,
    value: "ws_connecting",
    context: {
      version: 1,
      phase: "ws_connecting",
      credentials: persisted.credentials,
      wsUrl: persisted.wsUrl,
      userProfile: persisted.userProfile,
      qrData: null,
      cipherKey: null,
      pingIntervalMs: persisted.pingIntervalMs,
      errorMessage: null,
      reconnectCount: 0,
      lastConnectedAt: null,
      userAgent: persisted.credentials.userAgent,
      language: persisted.credentials.language ?? "vi",
    },
  };

  const bridge: BridgeSession = {
    sessionKey,
    callbackKey,
    socketId: bridgeResp.socket_id,
    bridgeUrl: resolvedBridgeUrl,
    persistedSessionRef: persisted.persistedSessionRef,
    socketStatus: "unknown",
  };

  await Promise.all([
    saveSerializedState(env, sessionKey, state),
    saveBridgeSession(env, sessionKey, bridge),
    saveCallbackBinding(env, callbackKey, sessionKey),
  ]);

  await updatePersistedLinkFromBridge(env, sessionKey, bridge, "unknown");

  return { sessionKey, state, bridge };
}

// ── Runtime artifact cleanup ──────────────────────────────────────────────────

export async function clearRuntimeArtifacts(
  env: Env,
  sessionKey: string,
): Promise<void> {
  serializedStateCache.delete(sessionKey);
  bridgeSessionCache.delete(sessionKey);
  const runtimeStore = await import("./runtime-store");
  await runtimeStore.clearRuntimeArtifacts(env, sessionKey);
}

// ── Cookie helpers ────────────────────────────────────────────────────────────

function base64UrlEncode(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function base64UrlDecode(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64url"));
}

async function getCookieCryptoKey(secret: string): Promise<CryptoKey> {
  const material = new TextEncoder().encode(secret);
  const digest = await crypto.subtle.digest("SHA-256", material);
  return crypto.subtle.importKey(
    "raw",
    digest,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptCookieValue(
  secret: string,
  persistedSessionRef: string,
): Promise<string> {
  const key = await getCookieCryptoKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(persistedSessionRef),
  );
  const payload = new Uint8Array(iv.length + cipher.byteLength);
  payload.set(iv, 0);
  payload.set(new Uint8Array(cipher), iv.length);
  return base64UrlEncode(payload);
}

export async function decryptCookieValue(
  secret: string,
  value: string,
): Promise<string | null> {
  try {
    const payload = base64UrlDecode(value);
    if (payload.length <= 12) {
      return null;
    }
    const iv = payload.slice(0, 12);
    const data = payload.slice(12);
    const key = await getCookieCryptoKey(secret);
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      data,
    );
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}
