import type {
  ConversationCache,
  Env,
  ParsedPacketEntry,
  PendingTelegramRequest,
} from "./types";

const PACKET_LOG_LIMIT = 50;

function pendingRequestsKey(sessionKey: string): string {
  return `pending-requests:${sessionKey}`;
}

function packetLogKey(sessionKey: string): string {
  return `packet-log:${sessionKey}`;
}

function conversationCacheKey(sessionKey: string): string {
  return `conversation-cache:${sessionKey}`;
}

export async function loadPendingRequests(
  env: Env,
  sessionKey: string,
): Promise<Record<string, PendingTelegramRequest>> {
  return (
    await env.TG_KV.get<Record<string, PendingTelegramRequest>>(
      pendingRequestsKey(sessionKey),
      "json",
    )
  ) || {};
}

async function savePendingRequests(
  env: Env,
  sessionKey: string,
  requests: Record<string, PendingTelegramRequest>,
): Promise<void> {
  await env.TG_KV.put(
    pendingRequestsKey(sessionKey),
    JSON.stringify(requests),
  );
}

export async function trackPendingRequest(
  env: Env,
  sessionKey: string,
  msgId: string,
  request: PendingTelegramRequest,
): Promise<void> {
  const requests = await loadPendingRequests(env, sessionKey);
  requests[msgId] = request;
  await savePendingRequests(env, sessionKey, requests);
}

export async function resolvePendingRequest(
  env: Env,
  sessionKey: string,
  msgId: string,
): Promise<PendingTelegramRequest | null> {
  const requests = await loadPendingRequests(env, sessionKey);
  const request = requests[msgId];
  if (!request) {
    return null;
  }
  delete requests[msgId];
  await savePendingRequests(env, sessionKey, requests);
  return request;
}

export async function loadPacketLog(
  env: Env,
  sessionKey: string,
): Promise<ParsedPacketEntry[]> {
  return (
    await env.TG_KV.get<ParsedPacketEntry[]>(
      packetLogKey(sessionKey),
      "json",
    )
  ) || [];
}

export async function appendPacketLog(
  env: Env,
  sessionKey: string,
  entries: ParsedPacketEntry[],
): Promise<ParsedPacketEntry[]> {
  if (entries.length === 0) {
    return loadPacketLog(env, sessionKey);
  }

  const current = await loadPacketLog(env, sessionKey);
  const next = current.concat(entries).slice(-PACKET_LOG_LIMIT);
  await env.TG_KV.put(packetLogKey(sessionKey), JSON.stringify(next));
  return next;
}

export async function loadConversationCache(
  env: Env,
  sessionKey: string,
): Promise<ConversationCache | null> {
  return env.TG_KV.get<ConversationCache>(
    conversationCacheKey(sessionKey),
    "json",
  );
}

export async function saveConversationCache(
  env: Env,
  sessionKey: string,
  cache: ConversationCache,
): Promise<void> {
  await env.TG_KV.put(
    conversationCacheKey(sessionKey),
    JSON.stringify(cache),
  );
}

export async function clearRuntimeArtifacts(
  env: Env,
  sessionKey: string,
): Promise<void> {
  await Promise.all([
    env.TG_KV.delete(pendingRequestsKey(sessionKey)),
    env.TG_KV.delete(packetLogKey(sessionKey)),
    env.TG_KV.delete(conversationCacheKey(sessionKey)),
  ]);
}
