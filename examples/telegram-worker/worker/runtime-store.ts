import type {
  Env,
  ParsedPacketEntry,
} from "./types";

const PACKET_LOG_LIMIT = 50;

function packetLogKey(sessionKey: string): string {
  return `packet-log:${sessionKey}`;
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

export async function clearRuntimeArtifacts(
  env: Env,
  sessionKey: string,
): Promise<void> {
  await Promise.all([
    env.TG_KV.delete(packetLogKey(sessionKey)),
    env.TG_KV.delete(`updates-state:${sessionKey}`),
  ]);
}
