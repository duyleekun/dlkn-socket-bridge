import test from "node:test";
import assert from "node:assert/strict";
import { handleSessionEvents } from "../worker/adapter/action-handler";
import { loadPacketLog } from "../worker/runtime-store";
import type { BridgeSession, Env } from "../worker/types";
import type { SessionSnapshot } from "gramjs-statemachine";

class MemoryKV {
  private store = new Map<string, string>();

  async get<T>(key: string, type?: "json"): Promise<T | string | null> {
    const value = this.store.get(key);
    if (value === undefined) {
      return null;
    }
    if (type === "json") {
      return JSON.parse(value) as T;
    }
    return value;
  }

  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

function fakeEnv(): Env {
  return {
    TG_KV: new MemoryKV() as unknown as KVNamespace,
    ASSETS: {} as Fetcher,
    TELEGRAM_API_ID: "12345",
    TELEGRAM_API_HASH: "hash",
    TELEGRAM_SESSION_COOKIE_SECRET: "secret",
  };
}

test("update packet log preserves inbound msgId and seqNo", async () => {
  const env = fakeEnv();
  const sessionKey = "session-1";
  const state = {
    version: 2,
    value: "ready",
    context: {
      protocolPhase: "READY",
    },
  } as SessionSnapshot;
  const bridge: BridgeSession = {
    sessionKey,
    callbackKey: "callback-1",
    socketId: "socket-1",
    bridgeUrl: "http://bridge.test",
    socketStatus: "healthy",
  };

  await handleSessionEvents(env, sessionKey, state, state, bridge, [
    {
      type: "update",
      update: {
        className: "UpdateShort",
        update: { className: "UpdateUserStatus" },
      },
      msgId: "123456789",
      seqNo: 7,
      envelopeClassName: "UpdateShort",
    },
  ]);

  const log = await loadPacketLog(env, sessionKey);
  assert.equal(log.length, 1);
  assert.equal(log[0]?.msgId, "123456789");
  assert.equal(log[0]?.seqNo, 7);
  assert.equal(log[0]?.className, "UpdateShort");
  assert.equal(log[0]?.envelopeClassName, "UpdateShort");
});
