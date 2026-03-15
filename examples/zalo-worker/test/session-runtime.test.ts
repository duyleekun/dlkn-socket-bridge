import test from "node:test";
import assert from "node:assert/strict";
import {
  createInitialState,
  createSnapshotFromState,
  encodeWsFrame,
  transitionSession,
} from "zca-js-statemachine";

function fakeCredentials() {
  return {
    imei: "imei-123",
    cookie: [
      {
        key: "zpsid",
        value: "cookie-value",
        domain: ".zalo.me",
        path: "/",
      },
    ],
    userAgent: "Mozilla/5.0",
    language: "vi",
  };
}

test("first cipher-key frame promotes ws_connecting to listening", async () => {
  const snapshot = createSnapshotFromState("qr_scanned", {
    ...createInitialState({
      userAgent: "Mozilla/5.0",
      language: "vi",
    }),
    phase: "qr_scanned",
  });

  const loggedIn = await transitionSession(snapshot, {
    type: "http_login_creds_result",
    credentials: fakeCredentials(),
    userProfile: {
      uid: "123456",
      displayName: "Zalo User",
      avatar: "https://example.com/avatar.png",
    },
    wsUrl: "wss://chat.zalo.me/ws?zpw_ver=671&zpw_type=30",
    pingIntervalMs: 20000,
  });

  assert.equal(loggedIn.snapshot.value, "ws_connecting");
  const reconnectCommand = loggedIn.commands.find((command) => command.type === "reconnect");
  assert.ok(reconnectCommand);
  assert.ok(loggedIn.commands.some((command) => command.type === "send_ping"));

  const handshakeFrame = encodeWsFrame(1, 1, 1, {
    key: "base64-cipher-key",
  });

  const listening = await transitionSession(loggedIn.snapshot, {
    type: "inbound_frame",
    frame: handshakeFrame,
  });

  assert.equal(listening.snapshot.value, "listening");
  assert.equal(listening.snapshot.context.cipherKey, "base64-cipher-key");
  assert.ok(listening.commands.some((command) => command.type === "send_ping"));
});

test("remote logout close stops reconnecting and clears persisted auth", async () => {
  const snapshot = createSnapshotFromState("listening", {
    ...createInitialState({
      userAgent: "Mozilla/5.0",
      language: "vi",
      credentials: fakeCredentials(),
    }),
    phase: "listening",
    credentials: fakeCredentials(),
    userProfile: {
      uid: "123456",
      displayName: "Zalo User",
      avatar: "https://example.com/avatar.png",
    },
    wsUrl: "wss://chat.zalo.me/ws?zpw_ver=671&zpw_type=30",
    cipherKey: "base64-cipher-key",
  });

  const result = await transitionSession(snapshot, {
    type: "ws_closed",
    code: 1000,
    reason: "error",
  });

  assert.equal(result.snapshot.value, "error");
  assert.equal(result.snapshot.context.credentials, null);
  assert.equal(result.snapshot.context.wsUrl, null);
  assert.equal(
    result.snapshot.context.errorMessage,
    "Zalo session ended remotely. Scan a new QR code to sign back in.",
  );
  assert.equal(result.commands.some((command) => command.type === "reconnect"), false);
  assert.equal(result.commands.some((command) => command.type === "clear_credentials"), true);
});
