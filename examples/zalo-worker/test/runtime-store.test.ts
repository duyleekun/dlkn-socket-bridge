import test from "node:test";
import assert from "node:assert/strict";
import type {
  Env,
  ZaloMessage,
} from "../worker/types";
import {
  appendMessage,
  buildRecoveryCommands,
  resolveMessageRecoveryCursor,
} from "../worker/runtime-store";

class MemoryKV {
  private store = new Map<string, string>();

  async get<T>(key: string, type?: "json"): Promise<T | null> {
    const value = this.store.get(key);
    if (value == null) return null;
    if (type === "json") return JSON.parse(value) as T;
    return value as T;
  }

  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

function makeEnv(): Env {
  return {
    ZALO_KV: new MemoryKV() as unknown as KVNamespace,
    ASSETS: {} as Fetcher,
    ZALO_SESSION_COOKIE_SECRET: "secret",
    WORKER_URL: "http://localhost:5173",
  };
}

function makeMessage(
  messageId: string,
  timestamp: number,
  threadType: 0 | 1,
): ZaloMessage {
  return {
    id: messageId,
    fromId: "1554887217481246386",
    content: "hello",
    timestamp,
    msgType: "webchat",
    isGroup: threadType === 1,
    recovered: false,
  } as ZaloMessage;
}

test("resolveMessageRecoveryCursor rebuilds missing cursor from persisted message log", async () => {
  const env = makeEnv();
  const sessionKey = "session-message-log";

  await appendMessage(env, sessionKey, makeMessage("dm-1", 1000, 0));
  await appendMessage(env, sessionKey, makeMessage("group-9", 2000, 1));

  const cursor = await resolveMessageRecoveryCursor(env, sessionKey);
  assert.equal(cursor.lastUserMessageId, "dm-1");
  assert.equal(cursor.lastGroupMessageId, "group-9");
});

test("buildRecoveryCommands emits DM and group recovery requests from the cursor", () => {
  const commands = buildRecoveryCommands({
    lastUserMessageId: "dm-7",
    lastGroupMessageId: "group-3",
  });

  assert.deepEqual(commands, [
    { type: "request_old_messages", threadType: 0, lastMessageId: "dm-7" },
    { type: "request_old_messages", threadType: 1, lastMessageId: "group-3" },
  ]);
});
