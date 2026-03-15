import type {
  Env,
  SocketActivityEntry,
  ZaloMessage,
  ZaloMessageRecoveryCursor,
} from './types.js';
import type { ZaloSessionCommand } from 'zca-js-statemachine';
import { readZaloMessage } from './types.js';

const MESSAGE_LOG_KEY = (sessionKey: string) => `zalo-message-log:${sessionKey}`;
const MESSAGE_CURSOR_KEY = (sessionKey: string) => `zalo-message-cursor:${sessionKey}`;
const SOCKET_ACTIVITY_KEY = (sessionKey: string) => `zalo-socket-activity:${sessionKey}`;
const MAX_MESSAGES = 50;
const MAX_SOCKET_ACTIVITY = 200;

function applyMessageCursorCandidate(
  cursor: ZaloMessageRecoveryCursor,
  candidate: { isGroup: boolean; messageId: string; timestamp: number },
): void {
  if (candidate.isGroup) {
    const lastTimestamp = cursor.lastGroupTimestamp ?? 0;
    if (candidate.timestamp >= lastTimestamp) {
      cursor.lastGroupMessageId = candidate.messageId;
      cursor.lastGroupTimestamp = candidate.timestamp;
    }
    return;
  }

  const lastTimestamp = cursor.lastUserTimestamp ?? 0;
  if (candidate.timestamp >= lastTimestamp) {
    cursor.lastUserMessageId = candidate.messageId;
    cursor.lastUserTimestamp = candidate.timestamp;
  }
}

function synthesizeCursorFromMessageLog(messages: ZaloMessage[]): ZaloMessageRecoveryCursor {
  const cursor: ZaloMessageRecoveryCursor = {};
  for (const message of messages) {
    const entry = readZaloMessage(message);
    if (!entry.id || entry.id === "0") continue;
    applyMessageCursorCandidate(cursor, {
      isGroup: message.isGroup,
      messageId: entry.id,
      timestamp: entry.timestamp,
    });
  }
  return cursor;
}

export async function loadMessageLog(env: Env, sessionKey: string): Promise<ZaloMessage[]> {
  return (await env.ZALO_KV.get<ZaloMessage[]>(MESSAGE_LOG_KEY(sessionKey), 'json')) ?? [];
}

export async function appendMessage(env: Env, sessionKey: string, message: ZaloMessage): Promise<void> {
  const log = await loadMessageLog(env, sessionKey);
  const messageId = readZaloMessage(message).id;
  const nextLog = log.filter((entry) => getMessageId(entry) !== messageId);
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

export async function resolveMessageRecoveryCursor(
  env: Env,
  sessionKey: string,
): Promise<ZaloMessageRecoveryCursor> {
  const stored = await loadMessageRecoveryCursor(env, sessionKey);
  if (stored.lastUserMessageId && stored.lastGroupMessageId) {
    return stored;
  }

  const messages = await loadMessageLog(env, sessionKey);
  const resolved = {
    ...synthesizeCursorFromMessageLog(messages),
    ...stored,
  } satisfies ZaloMessageRecoveryCursor;

  if (
    resolved.lastUserMessageId !== stored.lastUserMessageId ||
    resolved.lastUserTimestamp !== stored.lastUserTimestamp ||
    resolved.lastGroupMessageId !== stored.lastGroupMessageId ||
    resolved.lastGroupTimestamp !== stored.lastGroupTimestamp
  ) {
    resolved.updatedAt = Date.now();
    await env.ZALO_KV.put(MESSAGE_CURSOR_KEY(sessionKey), JSON.stringify(resolved));
  }

  return resolved;
}

export async function updateMessageRecoveryCursor(
  env: Env,
  sessionKey: string,
  message: ZaloMessage,
): Promise<void> {
  const current = await loadMessageRecoveryCursor(env, sessionKey);
  const updatedAt = Date.now();
  const { id: messageId, timestamp: messageTimestamp } = readZaloMessage(message);
  applyMessageCursorCandidate(current, {
    isGroup: message.isGroup,
    messageId,
    timestamp: messageTimestamp,
  });

  current.updatedAt = updatedAt;
  await env.ZALO_KV.put(MESSAGE_CURSOR_KEY(sessionKey), JSON.stringify(current));
}

function getMessageId(message: ZaloMessage): string {
  return readZaloMessage(message).id;
}

export function buildRecoveryCommands(
  cursor: ZaloMessageRecoveryCursor,
): Extract<ZaloSessionCommand, { type: 'request_old_messages' }>[] {
  const commands: Extract<ZaloSessionCommand, { type: 'request_old_messages' }>[] = [];
  if (cursor.lastUserMessageId) {
    commands.push({
      type: 'request_old_messages',
      threadType: 0,
      lastMessageId: cursor.lastUserMessageId,
    });
  }
  if (cursor.lastGroupMessageId) {
    commands.push({
      type: 'request_old_messages',
      threadType: 1,
      lastMessageId: cursor.lastGroupMessageId,
    });
  }
  return commands;
}

export async function loadSocketActivityLog(
  env: Env,
  sessionKey: string,
): Promise<SocketActivityEntry[]> {
  return (
    await env.ZALO_KV.get<SocketActivityEntry[]>(SOCKET_ACTIVITY_KEY(sessionKey), 'json')
  ) ?? [];
}

export async function appendSocketActivity(
  env: Env,
  sessionKey: string,
  activity: SocketActivityEntry,
): Promise<void> {
  await appendSocketActivityBatch(env, sessionKey, [activity]);
}

export async function appendSocketActivityBatch(
  env: Env,
  sessionKey: string,
  activities: SocketActivityEntry[],
): Promise<void> {
  if (activities.length === 0) return;
  const log = await loadSocketActivityLog(env, sessionKey);
  const nextLog = [...log, ...activities].slice(-MAX_SOCKET_ACTIVITY);
  await env.ZALO_KV.put(SOCKET_ACTIVITY_KEY(sessionKey), JSON.stringify(nextLog));
}

export async function cloneRuntimeArtifacts(
  env: Env,
  fromSessionKey: string,
  toSessionKey: string,
): Promise<void> {
  const [messages, cursor, socketActivity] = await Promise.all([
    loadMessageLog(env, fromSessionKey),
    loadMessageRecoveryCursor(env, fromSessionKey),
    loadSocketActivityLog(env, fromSessionKey),
  ]);

  await Promise.all([
    env.ZALO_KV.put(MESSAGE_LOG_KEY(toSessionKey), JSON.stringify(messages)),
    env.ZALO_KV.put(MESSAGE_CURSOR_KEY(toSessionKey), JSON.stringify(cursor)),
    env.ZALO_KV.put(SOCKET_ACTIVITY_KEY(toSessionKey), JSON.stringify(socketActivity)),
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

export async function clearSocketActivityLog(
  env: Env,
  sessionKey: string,
): Promise<void> {
  await env.ZALO_KV.delete(SOCKET_ACTIVITY_KEY(sessionKey));
}

export async function clearRuntimeArtifacts(env: Env, sessionKey: string): Promise<void> {
  await Promise.all([
    clearMessageLog(env, sessionKey),
    clearMessageRecoveryCursor(env, sessionKey),
    clearSocketActivityLog(env, sessionKey),
  ]);
}
