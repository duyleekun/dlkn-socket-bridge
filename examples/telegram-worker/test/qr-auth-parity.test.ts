import test from "node:test";
import assert from "node:assert/strict";
import {
  createInitialState,
  exportQrToken,
  importLoginToken,
  resolveTelegramDc,
  sendGetPassword,
  startDhExchange,
} from "gramjs-statemachine";
import type { SerializedState } from "gramjs-statemachine";
import { handleAction } from "../worker/adapter/action-handler";
import { loadBridgeSession, loadSerializedState } from "../worker/session-store";
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

function buildAuthReadyState(overrides: Partial<SerializedState> = {}): SerializedState {
  return {
    ...createInitialState({
      apiId: "12345",
      apiHash: "test-api-hash",
      dcMode: "production",
      dcId: 2,
      dcIp: "149.154.167.50",
      dcPort: 443,
    }),
    phase: "AUTH_KEY_READY",
    connectionInited: true,
    authKey: "aa".repeat(256),
    authKeyId: "bb".repeat(8),
    serverSalt: "cc".repeat(8),
    sessionId: "dd".repeat(8),
    ...overrides,
  };
}

function buildBridgeSession(overrides: Partial<BridgeSession> = {}): BridgeSession {
  return {
    sessionKey: "session-1",
    callbackKey: "callback-old",
    socketId: "socket-old",
    bridgeUrl: "http://bridge.test",
    authMode: "qr",
    phone: "",
    dcMode: "production",
    socketStatus: "unknown",
    ...overrides,
  };
}

async function readBodyBytes(body: BodyInit | null | undefined): Promise<Uint8Array> {
  if (!body) {
    return new Uint8Array();
  }
  if (body instanceof Uint8Array) {
    return body;
  }
  if (body instanceof ArrayBuffer) {
    return new Uint8Array(body);
  }
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  }
  if (typeof body === "string") {
    return new TextEncoder().encode(body);
  }
  const response = new Response(body);
  return new Uint8Array(await response.arrayBuffer());
}

function assertSingleTransportFrame(actual: Uint8Array, expectedLength: number): void {
  assert.equal(actual.length, expectedLength);
  const view = new DataView(actual.buffer, actual.byteOffset, actual.byteLength);
  assert.equal(view.getUint32(0, true), actual.length - 4);
}

test("login_qr_scanned sends the library-framed export bytes unchanged", async () => {
  const env = fakeEnv();
  const state = buildAuthReadyState({ phase: "AWAITING_QR_SCAN" });
  const bridge = buildBridgeSession();
  const expected = await exportQrToken(state);
  const sentBodies: Uint8Array[] = [];

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url === "http://bridge.test/sockets/socket-old" && init?.method === "POST") {
      sentBodies.push(await readBodyBytes(init.body));
      return new Response(null, { status: 200 });
    }
    throw new Error(`unexpected fetch: ${init?.method || "GET"} ${url}`);
  }) as typeof fetch;

  try {
    await handleAction(env, "http://worker.test", bridge.sessionKey, state, bridge, {
      type: "login_qr_scanned",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(sentBodies.length, 1);
  assertSingleTransportFrame(sentBodies[0], expected.outbound!.length);

  const savedState = await loadSerializedState(env, bridge.sessionKey);
  assert.equal(savedState?.phase, "QR_TOKEN_SENT");
});

test("auth_key_ready imports a pending QR token with library-framed bytes", async () => {
  const env = fakeEnv();
  const tokenBase64Url = Buffer.from("import-me").toString("base64url");
  const state = buildAuthReadyState();
  const bridge = buildBridgeSession({
    pendingQrImportTokenBase64Url: tokenBase64Url,
  });
  const expected = await importLoginToken(state, { tokenBase64Url });
  const sentBodies: Uint8Array[] = [];

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url === "http://bridge.test/sockets/socket-old" && init?.method === "POST") {
      sentBodies.push(await readBodyBytes(init.body));
      return new Response(null, { status: 200 });
    }
    throw new Error(`unexpected fetch: ${init?.method || "GET"} ${url}`);
  }) as typeof fetch;

  try {
    await handleAction(env, "http://worker.test", bridge.sessionKey, state, bridge, {
      type: "auth_key_ready",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(sentBodies.length, 1);
  assertSingleTransportFrame(sentBodies[0], expected.outbound!.length);

  const savedState = await loadSerializedState(env, bridge.sessionKey);
  const savedBridge = await loadBridgeSession(env, bridge.sessionKey);
  assert.equal(savedState?.phase, "QR_IMPORT_SENT");
  assert.equal(savedBridge?.pendingQrImportTokenBase64Url, undefined);
});

test("login_qr_migrate restarts auth on the target DC and preserves the import token", async () => {
  const env = fakeEnv();
  const state = buildAuthReadyState({ dcMode: "production", dcId: 2, dcIp: "149.154.167.50" });
  const bridge = buildBridgeSession();
  const targetDcId = 4;
  const tokenBase64Url = Buffer.from("migrate-me").toString("base64url");
  const resolvedDc = resolveTelegramDc("production", targetDcId);
  const expectedDh = await startDhExchange(
    createInitialState({
      dcId: resolvedDc.id,
      dcIp: resolvedDc.ip,
      dcPort: resolvedDc.port,
      dcMode: "production",
      apiId: env.TELEGRAM_API_ID,
      apiHash: env.TELEGRAM_API_HASH,
    }),
  );
  const sentBodies: Array<{ url: string; bytes: Uint8Array }> = [];
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
    if (url === "http://bridge.test/sockets/socket-new" && init?.method === "POST") {
      sentBodies.push({ url, bytes: await readBodyBytes(init.body) });
      return new Response(null, { status: 200 });
    }
    if (url === "http://bridge.test/sockets/socket-old" && init?.method === "DELETE") {
      deleteCalls.push(url);
      return new Response(null, { status: 200 });
    }
    throw new Error(`unexpected fetch: ${init?.method || "GET"} ${url}`);
  }) as typeof fetch;

  try {
    await handleAction(env, "http://worker.test", bridge.sessionKey, state, bridge, {
      type: "login_qr_migrate",
      targetDcId,
      tokenBase64Url,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(sentBodies.length, 1);
  assertSingleTransportFrame(sentBodies[0]!.bytes, expectedDh.outbound!.length);
  assert.deepEqual(deleteCalls, ["http://bridge.test/sockets/socket-old"]);

  const savedState = await loadSerializedState(env, bridge.sessionKey);
  const savedBridge = await loadBridgeSession(env, bridge.sessionKey);
  assert.equal(savedState?.phase, "PQ_SENT");
  assert.equal(savedState?.dcId, targetDcId);
  assert.equal(savedState?.dcIp, resolvedDc.ip);
  assert.equal(savedBridge?.socketId, "socket-new");
  assert.equal(savedBridge?.pendingQrImportTokenBase64Url, tokenBase64Url);
});

test("SESSION_PASSWORD_NEEDED after QR import requests password info", async () => {
  const env = fakeEnv();
  const state = buildAuthReadyState({ phase: "QR_IMPORT_SENT" });
  const bridge = buildBridgeSession({ socketId: "socket-password" });
  const expected = await sendGetPassword(state);
  const sentBodies: Uint8Array[] = [];

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url === "http://bridge.test/sockets/socket-password" && init?.method === "POST") {
      sentBodies.push(await readBodyBytes(init.body));
      return new Response(null, { status: 200 });
    }
    throw new Error(`unexpected fetch: ${init?.method || "GET"} ${url}`);
  }) as typeof fetch;

  try {
    await handleAction(env, "http://worker.test", bridge.sessionKey, state, bridge, {
      type: "error",
      message: "SESSION_PASSWORD_NEEDED",
      code: 401,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(sentBodies.length, 1);
  assertSingleTransportFrame(sentBodies[0], expected.outbound!.length);

  const savedState = await loadSerializedState(env, bridge.sessionKey);
  assert.equal(savedState?.phase, "PASSWORD_INFO_SENT");
});

test("AUTH_TOKEN_EXPIRED after QR import requests a fresh QR token", async () => {
  const env = fakeEnv();
  const state = buildAuthReadyState({ phase: "QR_IMPORT_SENT" });
  const bridge = buildBridgeSession({
    socketId: "socket-expired",
    pendingQrImportTokenBase64Url: Buffer.from("stale-token").toString("base64url"),
    qrLoginUrl: "tg://login?token=old",
    qrExpiresAt: Date.now() - 1_000,
  });
  const expected = await exportQrToken(state);
  const sentBodies: Uint8Array[] = [];

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url === "http://bridge.test/sockets/socket-expired" && init?.method === "POST") {
      sentBodies.push(await readBodyBytes(init.body));
      return new Response(null, { status: 200 });
    }
    throw new Error(`unexpected fetch: ${init?.method || "GET"} ${url}`);
  }) as typeof fetch;

  try {
    await handleAction(env, "http://worker.test", bridge.sessionKey, state, bridge, {
      type: "error",
      message: "AUTH_TOKEN_EXPIRED",
      code: 400,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(sentBodies.length, 1);
  assertSingleTransportFrame(sentBodies[0], expected.outbound!.length);

  const savedState = await loadSerializedState(env, bridge.sessionKey);
  const savedBridge = await loadBridgeSession(env, bridge.sessionKey);
  assert.equal(savedState?.phase, "QR_TOKEN_SENT");
  assert.equal(savedBridge?.pendingQrImportTokenBase64Url, undefined);
  assert.equal(savedBridge?.qrLoginUrl, undefined);
  assert.equal(savedBridge?.qrExpiresAt, undefined);
});

test("BadServerSalt during QR token flow resends exportQrToken with updated salt", async () => {
  const env = fakeEnv();
  const state = buildAuthReadyState({
    phase: "QR_TOKEN_SENT",
    serverSalt: "11".repeat(8),
  });
  const bridge = buildBridgeSession({ socketId: "socket-badsalt" });
  const expected = await exportQrToken(state);
  const sentBodies: Uint8Array[] = [];

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url === "http://bridge.test/sockets/socket-badsalt" && init?.method === "POST") {
      sentBodies.push(await readBodyBytes(init.body));
      return new Response(null, { status: 200 });
    }
    throw new Error(`unexpected fetch: ${init?.method || "GET"} ${url}`);
  }) as typeof fetch;

  try {
    await handleAction(env, "http://worker.test", bridge.sessionKey, state, bridge, {
      type: "bad_msg",
      errorCode: 48,
      badMsgId: "123",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(sentBodies.length, 1);
  assertSingleTransportFrame(sentBodies[0], expected.outbound!.length);

  const savedState = await loadSerializedState(env, bridge.sessionKey);
  assert.equal(savedState?.phase, "QR_TOKEN_SENT");
});
