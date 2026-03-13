import type {
  Env,
  ZaloMessage,
  ZaloMessageRecoveryCursor,
} from './types.js';

const MESSAGE_LOG_KEY = (sessionKey: string) => `zalo-message-log:${sessionKey}`;
const MESSAGE_CURSOR_KEY = (sessionKey: string) => `zalo-message-cursor:${sessionKey}`;
const MAX_MESSAGES = 50;

export async function loadMessageLog(env: Env, sessionKey: string): Promise<ZaloMessage[]> {
  return (await env.ZALO_KV.get<ZaloMessage[]>(MESSAGE_LOG_KEY(sessionKey), 'json')) ?? [];
}

export async function appendMessage(env: Env, sessionKey: string, message: ZaloMessage): Promise<void> {
  const log = await loadMessageLog(env, sessionKey);
  const nextLog = log.filter((entry) => entry.id !== message.id);
  nextLog.push(message);
  const trimmed = nextLog.slice(-MAX_MESSAGES);
  await Promise.all([
    env.ZALO_KV.put(MESSAGE_LOG_KEY(sessionKey), JSON.stringify(trimmed)),
    updateMessageRecoveryCursor(env, sessionKey, message),
  ]);
}

export async function loadMessageRecoveryCursor(
  env: Env,
  sessionKey: string,
): Promise<ZaloMessageRecoveryCursor> {
  return (
    await env.ZALO_KV.get<ZaloMessageRecoveryCursor>(MESSAGE_CURSOR_KEY(sessionKey), 'json')
  ) ?? {};
}

export async function updateMessageRecoveryCursor(
  env: Env,
  sessionKey: string,
  message: ZaloMessage,
): Promise<void> {
  const current = await loadMessageRecoveryCursor(env, sessionKey);
  const updatedAt = Date.now();

  if (message.threadType === 1) {
    const lastTimestamp = current.lastGroupTimestamp ?? 0;
    if (message.timestamp >= lastTimestamp) {
      current.lastGroupMessageId = message.id;
      current.lastGroupTimestamp = message.timestamp;
    }
  } else {
    const lastTimestamp = current.lastUserTimestamp ?? 0;
    if (message.timestamp >= lastTimestamp) {
      current.lastUserMessageId = message.id;
      current.lastUserTimestamp = message.timestamp;
    }
  }

  current.updatedAt = updatedAt;
  await env.ZALO_KV.put(MESSAGE_CURSOR_KEY(sessionKey), JSON.stringify(current));
}

export async function cloneRuntimeArtifacts(
  env: Env,
  fromSessionKey: string,
  toSessionKey: string,
): Promise<void> {
  const [messages, cursor] = await Promise.all([
    loadMessageLog(env, fromSessionKey),
    loadMessageRecoveryCursor(env, fromSessionKey),
  ]);

  await Promise.all([
    env.ZALO_KV.put(MESSAGE_LOG_KEY(toSessionKey), JSON.stringify(messages)),
    env.ZALO_KV.put(MESSAGE_CURSOR_KEY(toSessionKey), JSON.stringify(cursor)),
  ]);
}

export async function clearMessageLog(env: Env, sessionKey: string): Promise<void> {
  await env.ZALO_KV.delete(MESSAGE_LOG_KEY(sessionKey));
}

export async function clearMessageRecoveryCursor(
  env: Env,
  sessionKey: string,
): Promise<void> {
  await env.ZALO_KV.delete(MESSAGE_CURSOR_KEY(sessionKey));
}

export async function clearRuntimeArtifacts(env: Env, sessionKey: string): Promise<void> {
  await Promise.all([
    clearMessageLog(env, sessionKey),
    clearMessageRecoveryCursor(env, sessionKey),
  ]);
}
