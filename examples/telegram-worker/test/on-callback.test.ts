import test from "node:test";
import assert from "node:assert/strict";
import { createInitialState } from "gramjs-statemachine";
import { onCallback } from "../worker/adapter/on-callback";
import {
  loadSerializedState,
  saveBridgeSession,
  saveSerializedState,
} from "../worker/session-store";
import type { BridgeSession, Env } from "../worker/types";

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
    TELEGRAM_API_HASH: "0123456789abcdef0123456789abcdef",
    TELEGRAM_SESSION_COOKIE_SECRET: "secret",
  };
}

test("onCallback persists a deterministic error state for negative MTProto frames", async () => {
  const env = fakeEnv();
  const sessionKey = "session-1";
  const state = {
    ...createInitialState({
      apiId: env.TELEGRAM_API_ID,
      apiHash: env.TELEGRAM_API_HASH,
      dcMode: "production",
      dcId: 2,
      dcIp: "149.154.167.50",
      dcPort: 443,
    }),
    phase: "PQ_SENT" as const,
    dhNonce: "8d0ba199738749712f5a56ebedf25bf0",
    lastMsgId: "7301444403200000000",
  };
  const bridge: BridgeSession = {
    sessionKey,
    callbackKey: "callback-1",
    socketId: "socket-1",
    bridgeUrl: "http://bridge.test",
    authMode: "qr",
    phone: "",
    dcMode: "production",
    socketStatus: "unknown",
  };

  await Promise.all([
    saveSerializedState(env, sessionKey, state),
    saveBridgeSession(env, sessionKey, bridge),
  ]);

  await onCallback(
    env,
    "http://worker.test",
    sessionKey,
    new Uint8Array([4, 0, 0, 0, 0x6c, 0xfe, 0xff, 0xff]),
  );

  const savedState = await loadSerializedState(env, sessionKey);
  assert.equal(savedState?.phase, "ERROR");
  assert.equal(savedState?.error?.message, "MTProto server error: -404 during PQ_SENT");
});

test("onCallback ignores later frames once a session is already in ERROR", async () => {
  const env = fakeEnv();
  const sessionKey = "session-error";
  const state = {
    ...createInitialState({
      apiId: env.TELEGRAM_API_ID,
      apiHash: env.TELEGRAM_API_HASH,
      dcMode: "production",
      dcId: 2,
      dcIp: "149.154.167.50",
      dcPort: 443,
    }),
    phase: "ERROR" as const,
    error: {
      message: "incorrect header check",
    },
  };
  const bridge: BridgeSession = {
    sessionKey,
    callbackKey: "callback-2",
    socketId: "socket-2",
    bridgeUrl: "http://bridge.test",
    authMode: "qr",
    phone: "",
    dcMode: "production",
    socketStatus: "unknown",
  };

  await Promise.all([
    saveSerializedState(env, sessionKey, state),
    saveBridgeSession(env, sessionKey, bridge),
  ]);

  await onCallback(
    env,
    "http://worker.test",
    sessionKey,
    new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
  );

  const savedState = await loadSerializedState(env, sessionKey);
  assert.equal(savedState?.phase, "ERROR");
  assert.equal(savedState?.error?.message, "incorrect header check");
});
