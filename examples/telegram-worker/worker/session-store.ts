import { createSession } from "./bridge-client";
import { normalizeUrl, resolveBridgeUrl } from "./bridge-url";
import { generateNonce, toHex } from "./mtproto/crypto";
import type {
  Env,
  PersistedSessionLink,
  PersistedTelegramSession,
  SessionState,
  SocketStatus,
} from "./types";

export const SESSION_COOKIE_NAME = "tg_session_ref";

function sessionStateKey(sessionKey: string): string {
  return `session:${sessionKey}`;
}

function persistedSessionKey(persistedSessionRef: string): string {
  return `persisted:${persistedSessionRef}`;
}

function persistedLinkKey(persistedSessionRef: string): string {
  return `persisted-link:${persistedSessionRef}`;
}

export async function loadSessionState(
  env: Env,
  sessionKey: string,
): Promise<SessionState | null> {
  return env.TG_KV.get<SessionState>(sessionStateKey(sessionKey), "json");
}

export async function saveSessionState(
  env: Env,
  sessionKey: string,
  state: SessionState,
): Promise<void> {
  await env.TG_KV.put(sessionStateKey(sessionKey), JSON.stringify(state));
}

export async function deleteSessionState(
  env: Env,
  sessionKey: string,
): Promise<void> {
  await env.TG_KV.delete(sessionStateKey(sessionKey));
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

export function buildPersistedSessionRecord(
  state: SessionState,
): PersistedTelegramSession {
  if (!state.authKey || !state.serverSalt || !state.bridgeUrl) {
    throw new Error("cannot persist incomplete Telegram session");
  }
  const now = Date.now();
  return {
    version: 1,
    persistedSessionRef: state.persistedSessionRef || crypto.randomUUID(),
    authMode: state.authMode,
    phone: state.phone,
    dcMode: state.dcMode,
    dcId: state.dcId,
    dcIp: state.dcIp,
    dcPort: state.dcPort,
    bridgeUrl: resolveBridgeUrl(state.bridgeUrl),
    authKey: state.authKey,
    authKeyId: state.authKeyId,
    serverSalt: state.serverSalt,
    timeOffset: state.timeOffset,
    user: state.user,
    createdAt: now,
    updatedAt: now,
  };
}

export async function persistReadySession(
  env: Env,
  sessionKey: string,
  state: SessionState,
): Promise<SessionState> {
  const existingRecord = state.persistedSessionRef
    ? await loadPersistedSession(env, state.persistedSessionRef)
    : null;
  const baseRecord = buildPersistedSessionRecord(state);
  const record: PersistedTelegramSession = {
    ...baseRecord,
    createdAt: existingRecord?.createdAt ?? baseRecord.createdAt,
    updatedAt: Date.now(),
  };
  const nextState: SessionState = {
    ...state,
    persistedSessionRef: record.persistedSessionRef,
  };
  const link: PersistedSessionLink = {
    persistedSessionRef: record.persistedSessionRef,
    liveSessionKey: sessionKey,
    socketId: nextState.socketId,
    bridgeUrl: resolveBridgeUrl(nextState.bridgeUrl),
    updatedAt: Date.now(),
    socketHealth: nextState.socketStatus,
  };
  await Promise.all([
    savePersistedSession(env, record),
    savePersistedLink(env, link),
    saveSessionState(env, sessionKey, nextState),
  ]);
  return nextState;
}

export async function updatePersistedLinkFromState(
  env: Env,
  sessionKey: string,
  state: SessionState,
  socketHealth: SocketStatus = state.socketStatus,
): Promise<void> {
  if (!state.persistedSessionRef || !state.bridgeUrl) {
    return;
  }
  await savePersistedLink(env, {
    persistedSessionRef: state.persistedSessionRef,
    liveSessionKey: sessionKey,
    socketId: state.socketId,
    bridgeUrl: resolveBridgeUrl(state.bridgeUrl),
    updatedAt: Date.now(),
    socketHealth,
  });
}

export function shouldReuseRuntimeSession(
  state: SessionState | null,
  socketStatus: SocketStatus,
): boolean {
  return Boolean(state) && socketStatus === "healthy";
}

export async function rebuildSessionFromPersisted(
  env: Env,
  workerUrl: string,
  persisted: PersistedTelegramSession,
  bridgeUrl?: string,
): Promise<{ sessionKey: string; state: SessionState }> {
  const sessionKey = crypto.randomUUID();
  const normalizedWorkerUrl = normalizeUrl(workerUrl);
  const resolvedBridgeUrl = resolveBridgeUrl(bridgeUrl || persisted.bridgeUrl);
  const bridge = await createSession(
    resolvedBridgeUrl,
    `mtproto-frame://${persisted.dcIp}:${persisted.dcPort}`,
    `${normalizedWorkerUrl}/cb/${sessionKey}`,
  );

  const state: SessionState = {
    state: "READY",
    authMode: persisted.authMode,
    socketId: bridge.socket_id,
    bridgeUrl: resolvedBridgeUrl,
    phone: persisted.phone,
    dcMode: persisted.dcMode,
    dcId: persisted.dcId,
    dcIp: persisted.dcIp,
    dcPort: persisted.dcPort,
    authKey: persisted.authKey,
    authKeyId: persisted.authKeyId,
    serverSalt: persisted.serverSalt,
    sessionId: toHex(generateNonce(8)),
    seqNo: 0,
    timeOffset: persisted.timeOffset,
    connectionInited: false,
    user: persisted.user,
    error: undefined,
    pendingRequestId: undefined,
    phoneCodeHash: undefined,
    passwordHint: undefined,
    passwordSrp: undefined,
    qrLoginUrl: undefined,
    qrTokenBase64Url: undefined,
    qrExpiresAt: undefined,
    pendingQrImportTokenBase64Url: undefined,
    persistedSessionRef: persisted.persistedSessionRef,
    socketStatus: "unknown",
    socketLastCheckedAt: undefined,
    socketLastHealthyAt: undefined,
  };

  await saveSessionState(env, sessionKey, state);
  await updatePersistedLinkFromState(env, sessionKey, state, "unknown");
  return { sessionKey, state };
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
