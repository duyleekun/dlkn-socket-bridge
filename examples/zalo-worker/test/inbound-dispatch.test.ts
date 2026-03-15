import test from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import {
  buildOldMessagesFrame,
  createInitialState,
  createSnapshotFromState,
  decodeWsFrame,
  encodeWsFrame,
  extractSocketMessages,
  transitionSession,
} from "zca-js-statemachine";

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function makeRawFrame(
  version: number,
  cmd: number,
  subCmd: number,
  payload: string,
): Uint8Array {
  const payloadBytes = new TextEncoder().encode(payload);
  const buffer = new Uint8Array(4 + payloadBytes.length);
  const view = new DataView(buffer.buffer);
  view.setUint8(0, version);
  view.setUint16(1, cmd, true);
  view.setUint8(3, subCmd);
  buffer.set(payloadBytes, 4);
  return buffer;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer as ArrayBuffer;
}

async function encryptEventPayload(
  payload: unknown,
  options: { key: Uint8Array; compress: boolean },
): Promise<string> {
  const plainBytes = new TextEncoder().encode(JSON.stringify(payload));
  const source = options.compress ? deflateSync(plainBytes) : plainBytes;
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const aad = crypto.getRandomValues(new Uint8Array(16));
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(options.key),
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const encrypted = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: aad,
      tagLength: 128,
    },
    cryptoKey,
    toArrayBuffer(source),
  );
  return encodeURIComponent(
    bytesToBase64(concatBytes(iv, aad, new Uint8Array(encrypted))),
  );
}

function makeListeningSnapshot(cipherKey: string) {
  return createSnapshotFromState("listening", {
    ...createInitialState({
      userAgent: "Mozilla/5.0",
      language: "vi",
    }),
    phase: "listening",
    cipherKey,
    userProfile: {
      uid: "123456",
      displayName: "Zalo User",
      avatar: "https://example.com/avatar.png",
    },
  });
}

test("transitionSession stores cipher key from the websocket handshake payload", async () => {
  const snapshot = createSnapshotFromState("ws_connecting", {
    ...createInitialState({
      userAgent: "Mozilla/5.0",
      language: "vi",
    }),
    phase: "ws_connecting",
    userProfile: {
      uid: "123456",
      displayName: "Zalo User",
      avatar: "https://example.com/avatar.png",
    },
  });

  const result = await transitionSession(
    snapshot,
    {
      type: "inbound_frame",
      frame: encodeWsFrame(1, 1, 1, {
        key: "top-level-cipher-key",
      }),
    },
  );

  assert.equal(result.snapshot.value, "listening");
  assert.equal(result.snapshot.context.cipherKey, "top-level-cipher-key");
  assert.ok(result.commands.some((command) => command.type === "send_ping"));
  assert.deepEqual(result.events, []);
});

test("transitionSession passes through decrypted message frames without changing listening state", async () => {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const cipherKey = bytesToBase64(key);
  const payload = await encryptEventPayload(
    {
      data: {
        msgs: [
          {
            msgId: "1001",
            uidFrom: "1554887217481246386",
            idTo: "2002",
            ts: "1710000000000",
            content: "hello from zalo",
            msgType: "chat.message",
          },
        ],
      },
    },
    { key, compress: true },
  );

  const result = await transitionSession(
    makeListeningSnapshot(cipherKey),
    {
      type: "inbound_frame",
      frame: encodeWsFrame(1, 501, 0, {
        data: payload,
        encrypt: 2,
      }),
    },
  );

  assert.equal(result.snapshot.value, "listening");
  assert.equal(result.events.length, 1);
  const [event] = result.events;
  assert.equal(event.type, "frame");
  if (event.type !== "frame") {
    throw new Error("expected frame event");
  }
  assert.equal(event.payloadKind, "decrypted");
  const [message] = extractSocketMessages(event);
  assert.equal(message?.id, "1001");
  assert.equal(message?.fromId, "1554887217481246386");
  assert.equal(message?.content, "hello from zalo");
  assert.equal(message?.recovered, false);
});

test("transitionSession emits frame events for encrypt=3 payloads without changing state", async () => {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const cipherKey = bytesToBase64(key);
  const payload = await encryptEventPayload(
    {
      data: {
        ping: "ack",
      },
    },
    { key, compress: false },
  );

  const result = await transitionSession(
    makeListeningSnapshot(cipherKey),
    {
      type: "inbound_frame",
      frame: encodeWsFrame(1, 504, 0, {
        data: payload,
        encrypt: 3,
      }),
    },
  );

  assert.equal(result.snapshot.value, "listening");
  assert.equal(result.events.length, 1);
  const [event] = result.events;
  assert.equal(event.type, "frame");
  if (event.type !== "frame") {
    throw new Error("expected frame event");
  }
  assert.equal(event.cmd, 504);
  assert.equal(event.subCmd, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(event.data)), {
    data: {
      ping: "ack",
    },
  });
});

test("transitionSession emits frame events for decryptable but unmodeled commands", async () => {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const cipherKey = bytesToBase64(key);
  const payload = await encryptEventPayload(
    {
      error_code: 0,
      error_message: "",
      data: {
        error_message: "Success",
        data: "{\"mycloudMedia\":{\"pageSize\":300}}",
        error_code: 0,
      },
    },
    { key, compress: true },
  );

  const result = await transitionSession(
    makeListeningSnapshot(cipherKey),
    {
      type: "inbound_frame",
      frame: encodeWsFrame(1, 621, 0, {
        data: payload,
        encrypt: 2,
      }),
    },
  );

  assert.equal(result.snapshot.value, "listening");
  assert.equal(result.events.length, 1);
  const [event] = result.events;
  assert.equal(event.type, "frame");
  if (event.type !== "frame") {
    throw new Error("expected frame event");
  }
  assert.equal(event.cmd, 621);
  assert.equal(event.subCmd, 0);
});

test("transitionSession passes through empty 501 batches as frame events", async () => {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const cipherKey = bytesToBase64(key);
  const payload = await encryptEventPayload(
    {
      error_code: 0,
      error_message: "",
      data: {
        more: 0,
        msgs: [],
        groupMsgs: [],
        clearUnreads: [],
      },
    },
    { key, compress: true },
  );

  const result = await transitionSession(
    makeListeningSnapshot(cipherKey),
    {
      type: "inbound_frame",
      frame: encodeWsFrame(1, 501, 0, {
        data: payload,
        encrypt: 2,
      }),
    },
  );

  assert.equal(result.snapshot.value, "listening");
  assert.equal(result.events.length, 1);
  const [event] = result.events;
  assert.equal(event.type, "frame");
  if (event.type !== "frame") {
    throw new Error("expected frame event");
  }
  assert.equal(event.cmd, 501);
  assert.equal(event.subCmd, 0);
});

test("transitionSession passes through command 501 payloads without a msgs array", async () => {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const cipherKey = bytesToBase64(key);
  const payload = await encryptEventPayload(
    {
      error_code: 0,
      error_message: "",
      data: {
        more: 0,
        groupMsgs: [],
        clearUnreads: [],
      },
    },
    { key, compress: true },
  );

  const result = await transitionSession(
    makeListeningSnapshot(cipherKey),
    {
      type: "inbound_frame",
      frame: encodeWsFrame(1, 501, 0, {
        data: payload,
        encrypt: 2,
      }),
    },
  );

  assert.equal(result.snapshot.value, "listening");
  assert.equal(result.events.length, 1);
  const [event] = result.events;
  assert.equal(event.type, "frame");
  if (event.type !== "frame") {
    throw new Error("expected frame event");
  }
  assert.equal(event.cmd, 501);
  assert.equal(event.subCmd, 0);
});

test("transitionSession passes through frames when decrypt fails", async () => {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const wrongKey = crypto.getRandomValues(new Uint8Array(32));
  const cipherKey = bytesToBase64(wrongKey);
  const payload = await encryptEventPayload(
    {
      data: {
        msgs: [],
      },
    },
    { key, compress: true },
  );

  const result = await transitionSession(
    makeListeningSnapshot(cipherKey),
    {
      type: "inbound_frame",
      frame: encodeWsFrame(1, 501, 0, {
        data: payload,
        encrypt: 2,
      }),
    },
  );

  assert.equal(result.events.length, 1);
  const [event] = result.events;
  assert.equal(event.type, "frame");
  if (event.type !== "frame") {
    throw new Error("expected frame event");
  }
  assert.equal(event.cmd, 501);
  assert.equal(event.subCmd, 0);
});

test("transitionSession passes through malformed wrapper JSON", async () => {
  const result = await transitionSession(
    makeListeningSnapshot("cipher-key"),
    {
      type: "inbound_frame",
      frame: makeRawFrame(1, 501, 0, "{"),
    },
  );

  assert.equal(result.events.length, 1);
  const [event] = result.events;
  assert.equal(event.type, "frame");
  if (event.type !== "frame") {
    throw new Error("expected frame event");
  }
  assert.equal(event.cmd, 501);
  assert.equal(event.subCmd, 0);
  assert.equal(event.data, "{");
});

test("transitionSession ignores malformed frame headers", async () => {
  const result = await transitionSession(
    makeListeningSnapshot("cipher-key"),
    {
      type: "inbound_frame",
      frame: new Uint8Array([1, 2, 3]),
    },
  );

  assert.deepEqual(result.events, []);
});

test("buildOldMessagesFrame encodes user and group recovery requests", () => {
  const userFrame = decodeWsFrame(buildOldMessagesFrame(0, "msg-user-1"));
  assert.equal(userFrame.cmd, 510);
  assert.equal(userFrame.subCmd, 1);
  assert.deepEqual(JSON.parse(userFrame.payload), {
    first: true,
    lastId: "msg-user-1",
    preIds: [],
  });

  const groupFrame = decodeWsFrame(buildOldMessagesFrame(1, "msg-group-9"));
  assert.equal(groupFrame.cmd, 511);
  assert.equal(groupFrame.subCmd, 1);
  assert.deepEqual(JSON.parse(groupFrame.payload), {
    first: true,
    lastId: "msg-group-9",
    preIds: [],
  });
});

test("transitionSession marks old-message recovery batches as recovered", async () => {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const cipherKey = bytesToBase64(key);
  const payload = await encryptEventPayload(
    {
      data: {
        msgs: [
          {
            msgId: "2001",
            uidFrom: "1554887217481246386",
            idTo: "2002",
            ts: "1710000100000",
            content: "recovered hello",
            msgType: "chat.message",
          },
        ],
      },
    },
    { key, compress: true },
  );

  const result = await transitionSession(
    makeListeningSnapshot(cipherKey),
    {
      type: "inbound_frame",
      frame: encodeWsFrame(1, 510, 1, {
        data: payload,
        encrypt: 2,
      }),
    },
  );

  assert.equal(result.events.length, 1);
  const [event] = result.events;
  assert.equal(event.type, "frame");
  if (event.type !== "frame") {
    throw new Error("expected frame event");
  }
  const [message] = extractSocketMessages(event);
  assert.equal(message?.recovered, true);
  assert.equal(message?.id, "2001");
});

test("transitionSession moves duplicate connections into the error state", async () => {
  const result = await transitionSession(
    makeListeningSnapshot("cipher-key"),
    {
      type: "inbound_frame",
      frame: encodeWsFrame(1, 3000, 0, {}),
    },
  );

  assert.equal(result.snapshot.value, "error");
  assert.equal(result.snapshot.context.phase, "error");
  assert.equal(result.snapshot.context.errorMessage, "Duplicate Zalo connection detected.");
});
