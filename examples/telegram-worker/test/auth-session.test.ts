import test from "node:test";
import assert from "node:assert/strict";
import {
  buildApiMethod,
  buildExportLoginToken,
  buildImportLoginToken,
  buildSignIn,
  normalizePasswordSrp,
} from "../worker/mtproto/auth-steps";
import { Api } from "../worker/mtproto/serializer";
import { BridgeRequestError } from "../worker/bridge-client";
import { getSocketErrorStatus, isSocketGoneError } from "../worker/socket-health";
import {
  buildPersistedSessionRecord,
  decryptCookieValue,
  encryptCookieValue,
  shouldReuseRuntimeSession,
} from "../worker/session-store";
import type { SessionState } from "../worker/types";

function buildBaseState(): SessionState {
  return {
    state: "READY",
    authMode: "phone",
    socketId: "socket-1",
    bridgeUrl: "http://localhost:3000",
    phone: "+1234567890",
    dcMode: "test",
    dcId: 2,
    dcIp: "149.154.167.40",
    dcPort: 443,
    authKey: "00112233445566778899aabbccddeeff".repeat(16),
    authKeyId: "0011223344556677",
    serverSalt: "0011223344556677",
    sessionId: "8899aabbccddeeff",
    seqNo: 0,
    timeOffset: 0,
    connectionInited: false,
    socketStatus: "healthy",
    user: { id: 1, firstName: "Tester" },
  };
}

test("cookie encryption round-trips opaque session refs", async () => {
  const encrypted = await encryptCookieValue("secret", "persisted-ref");
  const decrypted = await decryptCookieValue("secret", encrypted);
  assert.equal(decrypted, "persisted-ref");
});

test("persisted session record captures READY restore fields", () => {
  const record = buildPersistedSessionRecord(buildBaseState());
  assert.equal(record.phone, "+1234567890");
  assert.equal(record.dcId, 2);
  assert.equal(record.authMode, "phone");
  assert.equal(record.authKey.length > 0, true);
});

test("runtime session reuse requires a healthy live socket", () => {
  const state = buildBaseState();
  assert.equal(shouldReuseRuntimeSession(state, "healthy"), true);
  assert.equal(shouldReuseRuntimeSession(state, "closed"), false);
  assert.equal(shouldReuseRuntimeSession(null, "healthy"), false);
});

test("bridge errors map to reconnectable socket states", () => {
  assert.equal(
    getSocketErrorStatus(new BridgeRequestError("missing", 404, "missing")),
    "closed",
  );
  assert.equal(
    getSocketErrorStatus(
      new BridgeRequestError("gone", 410, "session command channel closed"),
    ),
    "stale",
  );
  assert.equal(
    isSocketGoneError(
      new BridgeRequestError("gone", 410, "session command channel closed"),
    ),
    true,
  );
});

test("password SRP normalization stores JSON-safe challenge fields", () => {
  const algo =
    new Api.PasswordKdfAlgoSHA256SHA256PBKDF2HMACSHA512iter100000SHA256ModPow(
      {
        g: 2,
        p: Buffer.alloc(256, 1),
        salt1: Buffer.from("salt-one"),
        salt2: Buffer.from("salt-two"),
      },
    );
  const password = new Api.account.Password({
    hasPassword: true,
    currentAlgo: algo,
    srp_B: Buffer.alloc(256, 2),
    srpId: 99n,
    hint: "hint",
    newAlgo: algo,
    newSecureAlgo: new Api.SecurePasswordKdfAlgoPBKDF2HMACSHA512iter100000({
      salt: Buffer.alloc(32, 3),
    }),
    secureRandom: Buffer.alloc(32, 4),
  });

  const normalized = normalizePasswordSrp(password);
  assert.equal(normalized.passwordHint, "hint");
  assert.equal(normalized.passwordSrp?.srpId, "99");
  assert.equal(normalized.passwordSrp?.g, 2);
  assert.equal(normalized.passwordSrp?.srpBHex.length, 512);
});

test("authenticated request builders init connection when restoring a fresh runtime session", () => {
  const state = buildBaseState();

  const signIn = buildSignIn(
    {
      ...state,
      state: "AWAITING_CODE",
      phoneCodeHash: "hash",
    },
    "123",
    "12345",
  );
  assert.equal(signIn.stateUpdates.state, "SIGN_IN_SENT");
  assert.equal(signIn.stateUpdates.connectionInited, true);

  const apiMethod = buildApiMethod(state, "123", "help.GetConfig", {});
  assert.equal(apiMethod.stateUpdates.state, "READY");
  assert.equal(apiMethod.stateUpdates.connectionInited, true);

  const exportToken = buildExportLoginToken(state, "123", "hash");
  assert.equal(exportToken.stateUpdates.state, "QR_TOKEN_SENT");

  const importToken = buildImportLoginToken(state, "123", Buffer.from("token").toString("base64url"));
  assert.equal(importToken.stateUpdates.state, "QR_IMPORT_SENT");
});
