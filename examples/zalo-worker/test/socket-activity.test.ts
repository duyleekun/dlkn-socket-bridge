import test from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import {
  buildOldMessagesFrame,
  createInitialState,
  createSnapshotFromState,
  encodeWsFrame,
} from "zca-js-statemachine";
import {
  describeRxFrame,
  describeTxFrame,
} from "../worker/socket-activity";

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

test("describeRxFrame records message packets as decrypted frame events", async () => {
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

  const [entry] = await describeRxFrame(
    makeListeningSnapshot(cipherKey),
    encodeWsFrame(1, 501, 0, {
      data: payload,
      encrypt: 2,
    }),
  );

  assert.equal(entry.direction, "rx");
  assert.equal(entry.type, "frame");
  assert.equal(entry.cmd, 501);
  assert.equal(entry.subCmd, 0);
  assert.equal(entry.summary, "hello from zalo");
  assert.equal(entry.payloadKind, "decrypted");
  assert.match(entry.details ?? "", /chat\.message/);
});

test("describeRxFrame records self-sent 501 packets in socket activity", async () => {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const cipherKey = bytesToBase64(key);
  const payload = await encryptEventPayload(
    {
      data: {
        msgs: [
          {
            msgId: "1002",
            uidFrom: "0",
            idTo: "2002",
            ts: "1710000000001",
            content: "self message",
            msgType: "chat.message",
          },
        ],
      },
    },
    { key, compress: true },
  );

  const [entry] = await describeRxFrame(
    makeListeningSnapshot(cipherKey),
    encodeWsFrame(1, 501, 0, {
      data: payload,
      encrypt: 2,
    }),
  );

  assert.equal(entry.direction, "rx");
  assert.equal(entry.type, "frame");
  assert.equal(entry.cmd, 501);
  assert.equal(entry.summary, "self message");
});

test("describeRxFrame records cipher-key handshakes and ping frames", async () => {
  const handshakeEntries = await describeRxFrame(
    createSnapshotFromState("ws_connecting", {
      ...createInitialState({
        userAgent: "Mozilla/5.0",
        language: "vi",
      }),
      phase: "ws_connecting",
    }),
    encodeWsFrame(1, 1, 1, {
      key: "cipher-key",
    }),
  );
  assert.equal(handshakeEntries[0]?.type, "cipher_key");

  const pingEntries = await describeRxFrame(
    makeListeningSnapshot("cipher-key"),
    encodeWsFrame(1, 2, 1, {}),
  );
  assert.equal(pingEntries[0]?.type, "ping");
  assert.equal(pingEntries[0]?.summary, "Ping frame");
});

test("describeRxFrame passes through malformed wrapper JSON as a frame activity", async () => {
  const [entry] = await describeRxFrame(
    makeListeningSnapshot("cipher-key"),
    makeRawFrame(1, 501, 0, "{"),
  );

  assert.equal(entry.type, "frame");
  assert.equal(entry.cmd, 501);
  assert.equal(entry.subCmd, 0);
  assert.equal(entry.summary, "Inbound message frame");
  assert.equal(entry.details, "{");
});

test("describeRxFrame decrypts passthrough recovery frames for display", async () => {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const cipherKey = bytesToBase64(key);
  const payload = await encryptEventPayload(
    {
      data: {
        recoveredAt: 1710000000000,
        note: "queue sync response without messages",
      },
    },
    { key, compress: true },
  );

  const [entry] = await describeRxFrame(
    makeListeningSnapshot(cipherKey),
    encodeWsFrame(1, 511, 1, {
      data: payload,
      encrypt: 2,
    }),
  );

  assert.equal(entry.type, "frame");
  assert.equal(entry.cmd, 511);
  assert.equal(entry.subCmd, 1);
  assert.equal(entry.summary, "Inbound recovery frame");
  assert.match(entry.details ?? "", /queue sync response without messages/);
  assert.doesNotMatch(entry.details ?? "", /"encrypt":2/);
});

test("describeRxFrame keeps truly undecodable raw frames as unknown", async () => {
  const [entry] = await describeRxFrame(
    makeListeningSnapshot("cipher-key"),
    new Uint8Array([1, 2, 3]),
  );

  assert.equal(entry.type, "unknown");
  assert.equal(entry.cmd, undefined);
  assert.equal(entry.subCmd, undefined);
});

test("describeRxFrame keeps decryptable but unmodeled commands as frame", async () => {
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

  const [entry] = await describeRxFrame(
    makeListeningSnapshot(cipherKey),
    encodeWsFrame(1, 621, 0, {
      data: payload,
      encrypt: 2,
    }),
  );

  assert.equal(entry.type, "frame");
  assert.equal(entry.cmd, 621);
  assert.equal(entry.subCmd, 0);
});

test("describeTxFrame classifies ping, old-message recovery, and unknown outbound frames", () => {
  const ping = describeTxFrame(encodeWsFrame(1, 2, 1, {}));
  assert.equal(ping.direction, "tx");
  assert.equal(ping.type, "ping");

  const recovery = describeTxFrame(buildOldMessagesFrame(1, "group-last-1"));
  assert.equal(recovery.type, "request_old_messages");
  assert.match(recovery.summary, /group/);
  assert.match(recovery.details ?? "", /group-last-1/);

  const unknown = describeTxFrame(encodeWsFrame(1, 777, 5, { hello: "world" }));
  assert.equal(unknown.type, "unknown");
  assert.equal(unknown.cmd, 777);
  assert.equal(unknown.subCmd, 5);
});
