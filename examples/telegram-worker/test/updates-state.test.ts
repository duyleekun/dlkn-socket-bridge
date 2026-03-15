import test from "node:test";
import assert from "node:assert/strict";
import {
  Api,
} from "gramjs-statemachine";
import { createInitialState } from "../../../packages/gramjs-statemachine/src/types/state.js";
import { createSessionSnapshotFromLegacy } from "../../../packages/gramjs-statemachine/src/session/session-snapshot.js";
import { handleSessionEvents } from "../worker/adapter/action-handler";
import {
  loadPacketLog,
} from "../worker/runtime-store";
import {
  loadBridgeSession,
  loadPersistedSession,
  rebuildSessionFromPersisted,
  saveBridgeSession,
} from "../worker/session-store";
import type {
  BridgeSession,
  Env,
  TelegramUpdatesState,
} from "../worker/types";

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

function buildBridgeSession(
  overrides: Partial<BridgeSession> = {},
): BridgeSession {
  return {
    sessionKey: "session-1",
    callbackKey: "callback-1",
    socketId: "socket-1",
    bridgeUrl: "http://bridge.test",
    socketStatus: "healthy",
    ...overrides,
  };
}

function buildUpdatesState(
  overrides: Partial<TelegramUpdatesState> = {},
): TelegramUpdatesState {
  return {
    pts: 10,
    qts: 20,
    date: 30,
    seq: 40,
    updatedAt: Date.now(),
    source: "getState",
    ...overrides,
  };
}

test("handleSessionEvents stores updates state from updates.GetState", async () => {
  const env = fakeEnv();
  const state = buildReadyState();
  const bridge = buildBridgeSession();

  await handleSessionEvents(env, bridge.sessionKey, state, state, bridge, [
    {
      type: "decrypted_frame",
      object: {
        className: "RPCResult",
        reqMsgId: 123n,
        body: new Api.updates.State({
          pts: 101,
          qts: 202,
          date: 303,
          seq: 404,
          unreadCount: 0,
        }),
      },
      msgId: "999",
      seqNo: 3,
      requestName: "updates.GetState",
    },
  ]);

  const savedBridge = await loadBridgeSession(env, bridge.sessionKey);
  const updatesState = savedBridge?.updatesState;
  assert.deepEqual(updatesState && {
    pts: updatesState.pts,
    qts: updatesState.qts,
    date: updatesState.date,
    seq: updatesState.seq,
    source: updatesState.source,
  }, {
    pts: 101,
    qts: 202,
    date: 303,
    seq: 404,
    source: "getState",
  });
});

test("handleSessionEvents labels catch-up results and syncs persisted updates state", async () => {
  const env = fakeEnv();
  const previousState = {
    ...buildReadyState(),
    value: "authorizing" as const,
    context: {
      ...buildReadyState().context,
      protocolPhase: "QR_IMPORT_SENT" as const,
    },
  };
  const nextState = buildReadyState();
  const bridge = buildBridgeSession();

  const updatedBridge = await handleSessionEvents(
    env,
    bridge.sessionKey,
    previousState,
    nextState,
    bridge,
    [
      {
        type: "decrypted_frame",
        object: {
          className: "RPCResult",
          reqMsgId: 456n,
          body: new Api.updates.Difference({
            newMessages: [],
            newEncryptedMessages: [],
            otherUpdates: [],
            chats: [],
            users: [],
            state: new Api.updates.State({
              pts: 111,
              qts: 222,
              date: 333,
              seq: 444,
              unreadCount: 0,
            }),
          }),
        },
        msgId: "1000",
        seqNo: 4,
        requestName: "updates.GetDifference",
      },
    ],
  );

  const persisted = await loadPersistedSession(
    env,
    updatedBridge.persistedSessionRef!,
  );
  const packetLog = await loadPacketLog(env, bridge.sessionKey);
  assert.equal(persisted?.updatesState?.pts, 111);
  assert.equal(persisted?.updatesState?.source, "getDifference");
  assert.equal(packetLog[0]?.summary, "updates.GetDifference catch-up result");
});

test("inbound update envelopes advance the stored updates state without regressing", async () => {
  const env = fakeEnv();
  const state = buildReadyState();
  const bridge = buildBridgeSession({
    updatesState: buildUpdatesState(),
  });

  await saveBridgeSession(env, bridge.sessionKey, bridge);

  await handleSessionEvents(env, bridge.sessionKey, state, state, bridge, [
    {
      type: "decrypted_frame",
      object: {
        className: "UpdateShortMessage",
        pts: 15,
        date: 35,
      },
      msgId: "1001",
      seqNo: 5,
    },
  ]);

  const savedBridge = await loadBridgeSession(env, bridge.sessionKey);
  const updatesState = savedBridge?.updatesState;
  assert.equal(updatesState?.pts, 15);
  assert.equal(updatesState?.qts, 20);
  assert.equal(updatesState?.date, 35);
  assert.equal(updatesState?.seq, 40);
  assert.equal(updatesState?.source, "inboundUpdate");
});

test("rebuildSessionFromPersisted restores the last saved updates state", async () => {
  const env = fakeEnv();
  const previousState = {
    ...buildReadyState(),
    value: "authorizing" as const,
    context: {
      ...buildReadyState().context,
      protocolPhase: "QR_IMPORT_SENT" as const,
    },
  };
  const nextState = buildReadyState();
  const bridge = buildBridgeSession();

  const updatedBridge = await handleSessionEvents(
    env,
    bridge.sessionKey,
    previousState,
    nextState,
    bridge,
    [],
  );

  const persisted = await loadPersistedSession(
    env,
    updatedBridge.persistedSessionRef!,
  );
  assert.ok(persisted);

  persisted!.updatesState = buildUpdatesState({
    pts: 900,
    qts: 901,
    date: 902,
    seq: 903,
    source: "getState",
  });
  await env.TG_KV.put(
    `persisted:${persisted!.persistedSessionRef}`,
    JSON.stringify(persisted),
  );

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
    const restoredBridge = await loadBridgeSession(env, rebuilt.sessionKey);
    const restoredUpdatesState = restoredBridge?.updatesState;
    assert.equal(restoredUpdatesState?.pts, 900);
    assert.equal(restoredUpdatesState?.seq, 903);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
