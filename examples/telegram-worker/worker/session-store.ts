import { createSession } from "./bridge-client";
import { normalizeUrl, resolveBridgeUrl } from "./bridge-url";
import { generateNonce, toHex } from "./mtproto/crypto";
import type {
  BridgeSession,
  Env,
  PersistedSessionLink,
  PersistedTelegramSession,
  SocketStatus,
} from "./types";
import type { SerializedState } from "gramjs-statemachine";

export const SESSION_COOKIE_NAME = "tg_session_ref";

// ── KV key helpers ────────────────────────────────────────────────────────────

function serializedStateKey(sessionKey: string): string {
  return `sm-state:${sessionKey}`;
}

function bridgeSessionKey(sessionKey: string): string {
  return `bridge-session:${sessionKey}`;
}

function callbackBindingKey(callbackKey: string): string {
  return `callback:${callbackKey}`;
}

function persistedSessionKey(persistedSessionRef: string): string {
  return `persisted:${persistedSessionRef}`;
}

function persistedLinkKey(persistedSessionRef: string): string {
  return `persisted-link:${persistedSessionRef}`;
}

// ── In-memory caches (warm for a single Worker instance lifetime) ─────────────

const serializedStateCache = new Map<string, SerializedState>();
const bridgeSessionCache = new Map<string, BridgeSession>();

// ── State I/O ─────────────────────────────────────────────────────────────────

export async function loadSerializedState(
  env: Env,
  sessionKey: string,
): Promise<SerializedState | null> {
  const cached = serializedStateCache.get(sessionKey);
  if (cached) return cached;
  const state = await env.TG_KV.get<SerializedState>(serializedStateKey(sessionKey), "json");
  if (state) serializedStateCache.set(sessionKey, state);
  return state;
}

export async function saveSerializedState(
  env: Env,
  sessionKey: string,
  state: SerializedState,
): Promise<void> {
  serializedStateCache.set(sessionKey, state);
  await env.TG_KV.put(serializedStateKey(sessionKey), JSON.stringify(state));
}

export async function loadBridgeSession(
  env: Env,
  sessionKey: string,
): Promise<BridgeSession | null> {
  const cached = bridgeSessionCache.get(sessionKey);
  if (cached) return cached;
  const bridge = await env.TG_KV.get<BridgeSession>(bridgeSessionKey(sessionKey), "json");
  if (bridge) bridgeSessionCache.set(sessionKey, bridge);
  return bridge;
}

export async function saveBridgeSession(
  env: Env,
  sessionKey: string,
  bridge: BridgeSession,
): Promise<void> {
  bridgeSessionCache.set(sessionKey, bridge);
  await env.TG_KV.put(bridgeSessionKey(sessionKey), JSON.stringify(bridge));
}

export async function loadBoth(
  env: Env,
  sessionKey: string,
): Promise<{ state: SerializedState; bridge: BridgeSession } | null> {
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
  return env.TG_KV.get(callbackBindingKey(callbackKey));
}

export async function saveCallbackBinding(
  env: Env,
  callbackKey: string,
  sessionKey: string,
): Promise<void> {
  await env.TG_KV.put(callbackBindingKey(callbackKey), sessionKey);
}

export async function deleteCallbackBinding(
  env: Env,
  callbackKey: string | undefined,
): Promise<void> {
  if (!callbackKey) return;
  await env.TG_KV.delete(callbackBindingKey(callbackKey));
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
    env.TG_KV.delete(serializedStateKey(sessionKey)),
    env.TG_KV.delete(bridgeSessionKey(sessionKey)),
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
): Promise<PersistedTelegramSession | null> {
  return env.TG_KV.get<PersistedTelegramSession>(
    persistedSessionKey(persistedSessionRef),
    "json",
  );
}

export async function savePersistedSession(
  env: Env,
  record: PersistedTelegramSession,
): Promise<void> {
  await env.TG_KV.put(
    persistedSessionKey(record.persistedSessionRef),
    JSON.stringify(record),
  );
}

export async function loadPersistedLink(
  env: Env,
  persistedSessionRef: string,
): Promise<PersistedSessionLink | null> {
  return env.TG_KV.get<PersistedSessionLink>(
    persistedLinkKey(persistedSessionRef),
    "json",
  );
}

export async function savePersistedLink(
  env: Env,
  record: PersistedSessionLink,
): Promise<void> {
  await env.TG_KV.put(
    persistedLinkKey(record.persistedSessionRef),
    JSON.stringify(record),
  );
}

export async function deletePersistedSessionArtifacts(
  env: Env,
  persistedSessionRef: string,
): Promise<void> {
  await Promise.all([
    env.TG_KV.delete(persistedSessionKey(persistedSessionRef)),
    env.TG_KV.delete(persistedLinkKey(persistedSessionRef)),
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
 * Persist a ready (authenticated) session:
 * - Saves or updates the PersistedTelegramSession record
 * - Saves a PersistedSessionLink
 * - Updates BridgeSession with persistedSessionRef
 * - Saves both state and bridge back to KV
 *
 * Returns the updated BridgeSession.
 */
export async function persistReadySession(
  env: Env,
  sessionKey: string,
  state: SerializedState,
  bridge: BridgeSession,
  user?: Record<string, unknown>,
): Promise<BridgeSession> {
  if (!state.authKey || !state.serverSalt) {
    throw new Error("cannot persist incomplete Telegram session — missing authKey/serverSalt");
  }

  const persistedSessionRef = bridge.persistedSessionRef || crypto.randomUUID();
  const now = Date.now();

  const existing = bridge.persistedSessionRef
    ? await loadPersistedSession(env, bridge.persistedSessionRef)
    : null;

  const record: PersistedTelegramSession = {
    version: 1,
    persistedSessionRef,
    authMode: bridge.authMode,
    phone: bridge.phone,
    dcMode: state.dcMode,
    dcId: state.dcId,
    dcIp: state.dcIp,
    dcPort: state.dcPort,
    bridgeUrl: resolveBridgeUrl(bridge.bridgeUrl),
    authKey: state.authKey,
    authKeyId: state.authKeyId,
    serverSalt: state.serverSalt,
    timeOffset: state.timeOffset,
    user: user ?? state.user,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  const updatedBridge: BridgeSession = {
    ...bridge,
    persistedSessionRef,
  };

  const link: PersistedSessionLink = {
    persistedSessionRef,
    liveSessionKey: sessionKey,
    socketId: bridge.socketId,
    bridgeUrl: resolveBridgeUrl(bridge.bridgeUrl),
    updatedAt: now,
    socketHealth: bridge.socketStatus,
  };

  await Promise.all([
    savePersistedSession(env, record),
    savePersistedLink(env, link),
    saveBridgeSession(env, sessionKey, updatedBridge),
  ]);

  return updatedBridge;
}

/**
 * Rebuild a new SerializedState + BridgeSession from a persisted session record.
 * Used when resuming an existing authenticated session (cookie restore).
 */
export async function rebuildSessionFromPersisted(
  env: Env,
  workerUrl: string,
  persisted: PersistedTelegramSession,
  bridgeUrl?: string,
): Promise<{ sessionKey: string; state: SerializedState; bridge: BridgeSession }> {
  const sessionKey = crypto.randomUUID();
  const callbackKey = crypto.randomUUID();
  const normalizedWorkerUrl = normalizeUrl(workerUrl);
  const resolvedBridgeUrl = resolveBridgeUrl(bridgeUrl || persisted.bridgeUrl);
  const bridgeResp = await createSession(
    resolvedBridgeUrl,
    `mtproto-frame://${persisted.dcIp}:${persisted.dcPort}`,
    `${normalizedWorkerUrl}/cb/${callbackKey}`,
  );

  const state: SerializedState = {
    version: 1,
    phase: "READY",
    dcId: persisted.dcId,
    dcIp: persisted.dcIp,
    dcPort: persisted.dcPort,
    dcMode: persisted.dcMode,
    apiId: env.TELEGRAM_API_ID,
    apiHash: env.TELEGRAM_API_HASH,
    authKey: persisted.authKey,
    authKeyId: persisted.authKeyId,
    serverSalt: persisted.serverSalt,
    sessionId: toHex(generateNonce(8)),
    timeOffset: persisted.timeOffset,
    sequence: 0,
    lastMsgId: "0",
    connectionInited: false,
    pendingRequests: {},
    authMode: persisted.authMode,
    phone: persisted.phone,
    user: persisted.user,
  };

  const bridge: BridgeSession = {
    sessionKey,
    callbackKey,
    socketId: bridgeResp.socket_id,
    bridgeUrl: resolvedBridgeUrl,
    authMode: persisted.authMode,
    phone: persisted.phone,
    dcMode: persisted.dcMode,
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
