import test from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { createInitialState } from "zca-js-statemachine";
import { dispatchInboundFrame } from "../../../packages/zca-js-statemachine/src/dispatch/inbound-dispatch.js";
import {
  buildOldMessagesFrame,
  decodeFrame,
  encodeFrame,
} from "../../../packages/zca-js-statemachine/src/framing/zalo-frame-codec.js";

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

test("dispatchInboundFrame stores cipher key from the websocket handshake payload", async () => {
  const context = createInitialState({
    userAgent: "Mozilla/5.0",
    language: "vi",
  });

  const result = await dispatchInboundFrame(
    context,
    encodeFrame(1, 1, 1, {
      key: "top-level-cipher-key",
    }),
  );

  assert.equal(result.nextContext.cipherKey, "top-level-cipher-key");
  assert.deepEqual(result.events, []);
});

test("dispatchInboundFrame emits message events for encrypted user message batches", async () => {
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

  const result = await dispatchInboundFrame(
    {
      ...createInitialState({
        userAgent: "Mozilla/5.0",
        language: "vi",
      }),
      cipherKey,
    },
    encodeFrame(1, 501, 0, {
      data: payload,
      encrypt: 2,
    }),
  );

  assert.equal(result.events.length, 1);
  assert.deepEqual(result.events[0], {
    type: "message",
    message: {
      id: "1001",
      threadId: "1554887217481246386",
      threadType: 0,
      fromId: "1554887217481246386",
      content: "hello from zalo",
      attachments: [],
      timestamp: 1710000000000,
      msgType: "chat.message",
      recovered: false,
    },
  });
});

test("dispatchInboundFrame handles encrypt=3 payloads without inflating them", async () => {
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

  const result = await dispatchInboundFrame(
    {
      ...createInitialState({
        userAgent: "Mozilla/5.0",
        language: "vi",
      }),
      cipherKey,
    },
    encodeFrame(1, 504, 0, {
      data: payload,
      encrypt: 3,
    }),
  );

  assert.deepEqual(result.events, [
    {
      type: "update",
      data: {
        cmd: 504,
        subCmd: 0,
        data: {
          data: {
            ping: "ack",
          },
        },
      },
    },
  ]);
});

test("buildOldMessagesFrame encodes user and group recovery requests", () => {
  const userFrame = decodeFrame(buildOldMessagesFrame(0, "msg-user-1"));
  assert.equal(userFrame.cmd, 510);
  assert.equal(userFrame.subCmd, 1);
  assert.deepEqual(JSON.parse(userFrame.payload), {
    first: true,
    lastId: "msg-user-1",
    preIds: [],
  });

  const groupFrame = decodeFrame(buildOldMessagesFrame(1, "msg-group-9"));
  assert.equal(groupFrame.cmd, 511);
  assert.equal(groupFrame.subCmd, 1);
  assert.deepEqual(JSON.parse(groupFrame.payload), {
    first: true,
    lastId: "msg-group-9",
    preIds: [],
  });
});

test("dispatchInboundFrame marks old-message recovery batches as recovered", async () => {
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

  const result = await dispatchInboundFrame(
    {
      ...createInitialState({
        userAgent: "Mozilla/5.0",
        language: "vi",
      }),
      cipherKey,
    },
    encodeFrame(1, 510, 1, {
      data: payload,
      encrypt: 2,
    }),
  );

  assert.deepEqual(result.events, [
    {
      type: "message",
      message: {
        id: "2001",
        threadId: "1554887217481246386",
        threadType: 0,
        fromId: "1554887217481246386",
        content: "recovered hello",
        attachments: [],
        timestamp: 1710000100000,
        msgType: "chat.message",
        recovered: true,
      },
    },
  ]);
});
