import { createSession } from "./bridge-client";
import { normalizeUrl, resolveBridgeUrl } from "./bridge-url";
import type {
  BridgeSession,
  Env,
  PersistedTelegramSession,
  TelegramUpdatesState,
} from "./types";
import type { SessionSnapshot } from "gramjs-statemachine";

export const SESSION_COOKIE_NAME = "tg_session_ref";

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function randomHex(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

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

export async function loadSerializedState(
  env: Env,
  sessionKey: string,
): Promise<SessionSnapshot | null> {
  return env.TG_KV.get<SessionSnapshot>(serializedStateKey(sessionKey), "json");
}

export async function saveSerializedState(
  env: Env,
  sessionKey: string,
  state: SessionSnapshot,
): Promise<void> {
  await env.TG_KV.put(serializedStateKey(sessionKey), JSON.stringify(state));
}

export async function loadBridgeSession(
  env: Env,
  sessionKey: string,
): Promise<BridgeSession | null> {
  return env.TG_KV.get<BridgeSession>(bridgeSessionKey(sessionKey), "json");
}

export async function saveBridgeSession(
  env: Env,
  sessionKey: string,
  bridge: BridgeSession,
): Promise<void> {
  await env.TG_KV.put(bridgeSessionKey(sessionKey), JSON.stringify(bridge));
}

export async function loadBoth(
  env: Env,
  sessionKey: string,
): Promise<{ state: SessionSnapshot; bridge: BridgeSession } | null> {
  const [state, bridge] = await Promise.all([
    loadSerializedState(env, sessionKey),
    loadBridgeSession(env, sessionKey),
  ]);
  if (!state || !bridge) {
    return null;
  }
  return { state, bridge };
}

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
  if (!callbackKey) {
    return;
  }
  await env.TG_KV.delete(callbackBindingKey(callbackKey));
}

export async function deleteSession(
  env: Env,
  sessionKey: string,
): Promise<void> {
  await Promise.all([
    env.TG_KV.delete(serializedStateKey(sessionKey)),
    env.TG_KV.delete(bridgeSessionKey(sessionKey)),
  ]);
}

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

export async function deletePersistedSessionArtifacts(
  env: Env,
  persistedSessionRef: string,
): Promise<void> {
  await env.TG_KV.delete(persistedSessionKey(persistedSessionRef));
}

export async function savePersistedSessionUpdatesState(
  env: Env,
  persistedSessionRef: string,
  updatesState: TelegramUpdatesState,
): Promise<void> {
  const existing = await loadPersistedSession(env, persistedSessionRef);
  if (!existing) {
    return;
  }
  await savePersistedSession(env, {
    ...existing,
    updatesState,
    updatedAt: Date.now(),
  });
}

export async function persistReadySession(
  env: Env,
  sessionKey: string,
  state: SessionSnapshot,
  bridge: BridgeSession,
  user?: Record<string, unknown>,
  updatesState?: TelegramUpdatesState | null,
): Promise<BridgeSession> {
  if (!state.context.authKey || !state.context.serverSalt) {
    throw new Error("cannot persist incomplete Telegram session");
  }

  const persistedSessionRef = bridge.persistedSessionRef || crypto.randomUUID();
  const now = Date.now();
  const existing = bridge.persistedSessionRef
    ? await loadPersistedSession(env, bridge.persistedSessionRef)
    : null;

  const record: PersistedTelegramSession = {
    version: 1,
    persistedSessionRef,
    authMode: state.context.authMode || "qr",
    phone: state.context.phone || "",
    dcMode: state.context.dcMode,
    dcId: state.context.dcId,
    dcIp: state.context.dcIp,
    dcPort: state.context.dcPort,
    bridgeUrl: resolveBridgeUrl(bridge.bridgeUrl),
    authKey: state.context.authKey,
    authKeyId: state.context.authKeyId,
    serverSalt: state.context.serverSalt,
    timeOffset: state.context.timeOffset,
    user: user ?? state.context.user,
    updatesState: updatesState ?? existing?.updatesState,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  const updatedBridge: BridgeSession = {
    ...bridge,
    persistedSessionRef,
    updatesState: updatesState ?? bridge.updatesState ?? existing?.updatesState,
  };

  await Promise.all([
    savePersistedSession(env, record),
    saveBridgeSession(env, sessionKey, updatedBridge),
  ]);

  return updatedBridge;
}

export async function rebuildSessionFromPersisted(
  env: Env,
  workerUrl: string,
  persisted: PersistedTelegramSession,
  bridgeUrl?: string,
): Promise<{ sessionKey: string; state: SessionSnapshot; bridge: BridgeSession }> {
  const sessionKey = crypto.randomUUID();
  const callbackKey = crypto.randomUUID();
  const normalizedWorkerUrl = normalizeUrl(workerUrl);
  const resolvedBridgeUrl = resolveBridgeUrl(bridgeUrl || persisted.bridgeUrl);
  const bridgeResp = await createSession(
    resolvedBridgeUrl,
    `mtproto-frame://${persisted.dcIp}:${persisted.dcPort}`,
    `${normalizedWorkerUrl}/cb/${callbackKey}`,
  );

  const state: SessionSnapshot = {
    version: 2,
    value: "ready",
    context: {
      protocolPhase: "READY",
      dcId: persisted.dcId,
      dcIp: persisted.dcIp,
      dcPort: persisted.dcPort,
      dcMode: persisted.dcMode,
      apiId: env.TELEGRAM_API_ID,
      apiHash: env.TELEGRAM_API_HASH,
      authKey: persisted.authKey,
      authKeyId: persisted.authKeyId,
      serverSalt: persisted.serverSalt,
      sessionId: randomHex(8),
      timeOffset: persisted.timeOffset,
      sequence: 0,
      lastMsgId: "0",
      connectionInited: false,
      pendingRequests: {},
      authMode: persisted.authMode,
      phone: persisted.phone,
      user: persisted.user,
    },
  };

  const bridge: BridgeSession = {
    sessionKey,
    callbackKey,
    socketId: bridgeResp.socket_id,
    bridgeUrl: resolvedBridgeUrl,
    persistedSessionRef: persisted.persistedSessionRef,
    updatesState: persisted.updatesState,
    socketStatus: "unknown",
  };

  await Promise.all([
    saveSerializedState(env, sessionKey, state),
    saveBridgeSession(env, sessionKey, bridge),
    saveCallbackBinding(env, callbackKey, sessionKey),
  ]);

  return { sessionKey, state, bridge };
}

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
