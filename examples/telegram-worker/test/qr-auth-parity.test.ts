import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveTelegramDc,
  transitionSession,
} from "gramjs-statemachine";
import { createInitialState } from "../../../packages/gramjs-statemachine/src/types/state.js";
import { startDhExchange } from "../../../packages/gramjs-statemachine/src/dh/dh-step1-req-pq.js";
import { handleSessionEvents } from "../worker/adapter/action-handler";
import { applyReconnectCommand } from "../worker/bridge-session";
import { createSessionSnapshotFromLegacy } from "../../../packages/gramjs-statemachine/src/session/session-snapshot.js";
import {
  loadBridgeSession,
  loadPersistedSession,
  loadSerializedState,
  loadSessionKeyByCallbackKey,
  rebuildSessionFromPersisted,
  saveBridgeSession,
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
    TELEGRAM_API_HASH: "test-api-hash",
    TELEGRAM_SESSION_COOKIE_SECRET: "secret",
  };
}

function buildReadyState() {
  return createSessionSnapshotFromLegacy({
    ...createInitialState({
      apiId: "12345",
      apiHash: "test-api-hash",
      dcMode: "production",
      dcId: 2,
      dcIp: "149.154.167.50",
      dcPort: 443,
      authMode: "qr",
    }),
    phase: "READY" as const,
    connectionInited: true,
    authKey: "aa".repeat(256),
    authKeyId: "bb".repeat(8),
    serverSalt: "cc".repeat(8),
    sessionId: "dd".repeat(8),
    user: { id: "1", firstName: "Duy" },
  });
}

function buildBridgeSession(overrides: Partial<BridgeSession> = {}): BridgeSession {
  return {
    sessionKey: "session-1",
    callbackKey: "callback-old",
    socketId: "socket-old",
    bridgeUrl: "http://bridge.test",
    socketStatus: "unknown",
    ...overrides,
  };
}

test("advanceSession preserves deterministic ERROR state for negative MTProto frames", async () => {
  const state = {
    ...createInitialState({
      apiId: "12345",
      apiHash: "test-api-hash",
      dcMode: "production",
      dcId: 2,
      dcIp: "149.154.167.50",
      dcPort: 443,
      authMode: "qr",
    }),
    phase: "PQ_SENT" as const,
  };

  const result = await transitionSession(
    createSessionSnapshotFromLegacy(state),
    {
      type: "inbound_frame",
      frame: new Uint8Array([4, 0, 0, 0, 0x6c, 0xfe, 0xff, 0xff]),
    },
  );

  assert.equal(result.snapshot.context.protocolPhase, "ERROR");
  assert.equal(result.snapshot.context.error?.message, "MTProto server error: -404 during PQ_SENT");
  assert.deepEqual(result.commands, []);
  assert.deepEqual(result.events, []);
});

test("applyReconnectDirective rotates the bridge socket and callback binding", async () => {
  const env = fakeEnv();
  const bridge = buildBridgeSession();
  await saveBridgeSession(env, bridge.sessionKey, bridge);

  const targetDc = resolveTelegramDc("production", 4);
  const dh = await startDhExchange(
    createInitialState({
      apiId: env.TELEGRAM_API_ID,
      apiHash: env.TELEGRAM_API_HASH,
      dcMode: "production",
      dcId: targetDc.id,
      dcIp: targetDc.ip,
      dcPort: targetDc.port,
      authMode: "qr",
      pendingQrImportTokenBase64Url: Buffer.from("migrate-me").toString("base64url"),
    }),
  );

  const deleteCalls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url === "http://bridge.test/sockets" && init?.method === "POST") {
      return new Response(
        JSON.stringify({
          socket_id: "socket-new",
          send_url: "/sockets/socket-new",
          delete_url: "/sockets/socket-new",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
    if (url === "http://bridge.test/sockets/socket-old" && init?.method === "DELETE") {
      deleteCalls.push(url);
      return new Response(null, { status: 200 });
    }
    throw new Error(`unexpected fetch: ${init?.method || "GET"} ${url}`);
  }) as typeof fetch;

  try {
    const updatedBridge = await applyReconnectCommand(
      env,
      "http://worker.test",
      bridge.sessionKey,
      bridge,
      {
        type: "reconnect",
        reason: "dc_migrate",
        dcId: targetDc.id,
        dcIp: targetDc.ip,
        dcPort: targetDc.port,
        firstFrame: dh.outbound!,
      },
    );

    assert.equal(updatedBridge.socketId, "socket-new");
    assert.notEqual(updatedBridge.callbackKey, bridge.callbackKey);
    assert.deepEqual(deleteCalls, ["http://bridge.test/sockets/socket-old"]);

    const savedBridge = await loadBridgeSession(env, bridge.sessionKey);
    assert.equal(savedBridge?.socketId, "socket-new");

    const oldBinding = await loadSessionKeyByCallbackKey(env, bridge.callbackKey);
    const newBinding = await loadSessionKeyByCallbackKey(env, updatedBridge.callbackKey);
    assert.equal(oldBinding, null);
    assert.equal(newBinding, bridge.sessionKey);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("handleSessionEvents persists QR auth state when the session reaches READY", async () => {
  const env = fakeEnv();
  const previousState = {
    ...buildReadyState(),
    value: "authorizing" as const,
    context: {
      ...buildReadyState().context,
      protocolPhase: "QR_IMPORT_SENT" as const,
      user: undefined,
      authMode: "qr" as const,
      pendingQrImportTokenBase64Url: Buffer.from("import-me").toString("base64url"),
      qrLoginUrl: "tg://login?token=old",
      qrExpiresAt: Date.now() - 1000,
    },
  };
  const nextState = {
    ...buildReadyState(),
    context: {
      ...buildReadyState().context,
      authMode: "qr" as const,
      phone: "",
      pendingQrImportTokenBase64Url: undefined,
      qrLoginUrl: undefined,
      qrExpiresAt: undefined,
    },
  };
  const bridge = buildBridgeSession();

  const updatedBridge = await handleSessionEvents(
    env,
    bridge.sessionKey,
    previousState,
    nextState,
    bridge,
    [],
  );

  assert.ok(updatedBridge.persistedSessionRef);
  const persisted = await loadPersistedSession(env, updatedBridge.persistedSessionRef!);
  assert.equal(persisted?.authMode, "qr");
  assert.equal(persisted?.phone, "");
  assert.equal(persisted?.user?.id, "1");
});

test("rebuildSessionFromPersisted creates a fresh runtime session from persisted auth", async () => {
  const env = fakeEnv();
  const bridge = buildBridgeSession({ persistedSessionRef: "persisted-1" });
  await saveBridgeSession(env, bridge.sessionKey, bridge);

  const updatedBridge = await handleSessionEvents(
    env,
    bridge.sessionKey,
    {
      ...buildReadyState(),
      value: "authorizing",
      context: {
        ...buildReadyState().context,
        protocolPhase: "QR_IMPORT_SENT",
      },
    },
    buildReadyState(),
    bridge,
    [],
  );
  const persisted = await loadPersistedSession(env, updatedBridge.persistedSessionRef!);
  assert.ok(persisted);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url === "http://bridge.test/sockets" && init?.method === "POST") {
      return new Response(
        JSON.stringify({
          socket_id: "socket-restored",
          send_url: "/sockets/socket-restored",
          delete_url: "/sockets/socket-restored",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
    throw new Error(`unexpected fetch: ${init?.method || "GET"} ${url}`);
  }) as typeof fetch;

  try {
    const rebuilt = await rebuildSessionFromPersisted(
      env,
      "http://worker.test",
      persisted!,
    );
    assert.notEqual(rebuilt.sessionKey, bridge.sessionKey);
    assert.equal(rebuilt.bridge.socketId, "socket-restored");
    assert.equal(rebuilt.bridge.persistedSessionRef, persisted?.persistedSessionRef);

    const savedState = await loadSerializedState(env, rebuilt.sessionKey);
    const callbackSessionKey = await loadSessionKeyByCallbackKey(env, rebuilt.bridge.callbackKey);
    assert.equal(savedState?.value, "ready");
    assert.equal(callbackSessionKey, rebuilt.sessionKey);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
