import test from "node:test";
import assert from "node:assert/strict";
import { Api, serializeTLObject } from "../worker/mtproto/serializer";
import {
  aesIgeDecrypt,
  aesIgeEncrypt,
  concatBytes,
  fingerprintToHex,
  fromHex,
  KNOWN_RSA_FINGERPRINTS,
  sha1,
  tlBigIntFromBytesBE,
  tlBigIntFromBytesLE,
  tlBigIntToBytesLE,
  xorBytes,
} from "../worker/mtproto/crypto";
import { deriveAesKeyIv } from "../worker/mtproto/encrypted-message";
import {
  gramjsAesIgeDecrypt,
  gramjsAesIgeEncrypt,
  gramjsDeriveMessageAesKeyIv,
  gramjsDeriveTempAesKeyIv,
  gramjsFingerprintToHex,
  gramjsSerializeClientDhInnerData,
  gramjsSerializePqInnerData,
  gramjsSignedBigIntFromBytesBE,
  gramjsSignedBigIntFromBytesLE,
  gramjsSignedBigIntToBytesLE,
} from "../worker/mtproto/gramjs-oracle";
import { getDefaultTelegramDc, parseMigrateDc } from "../worker/mtproto/dc";
import { isQuickAck, stripTransportFrame, wrapTransportFrame } from "../worker/mtproto/transport";

function hex(value: string): Uint8Array {
  return fromHex(value.replace(/\s+/g, ""));
}

test("transport framing preserves payloads and quick acks", () => {
  const payload = hex("11223344aabbccdd");
  const frame = wrapTransportFrame(payload);
  assert.equal(frame.length, payload.length + 4);
  assert.deepEqual(stripTransportFrame(frame), payload);

  const quickAck = hex("6cfeffff");
  assert.equal(isQuickAck(quickAck), true);
  assert.deepEqual(stripTransportFrame(quickAck), quickAck);
});

test("signed TL bigint conversions match GramJS", () => {
  const beNonce = hex("93ee342c0b828711a3a0486eee98acd0");
  const leNonce = hex("e55ca249b0d2d4ece32f3fd27d1c1f3c");

  const be = tlBigIntFromBytesBE(beNonce);
  const le = tlBigIntFromBytesLE(leNonce);
  assert.equal(be.toString(), gramjsSignedBigIntFromBytesBE(beNonce).toString());
  assert.equal(le.toString(), gramjsSignedBigIntFromBytesLE(leNonce).toString());
  assert.deepEqual(tlBigIntToBytesLE(le, 16), gramjsSignedBigIntToBytesLE(le, 16));
});

test("fingerprint formatting matches GramJS wire representation", () => {
  const fingerprint = tlBigIntFromBytesBE(hex("b25898df208d2603"));
  assert.equal(fingerprintToHex(fingerprint), gramjsFingerprintToHex(fingerprint));
  assert.equal(fingerprintToHex(fingerprint), "b25898df208d2603");
});

test("known RSA fingerprints come from GramJS and keep wire byte order", () => {
  assert.deepEqual(
    KNOWN_RSA_FINGERPRINTS.sort(),
    ["b25898df208d2603", "d09d1d85de64fd85"].sort(),
  );
});

test("DC helper exposes defaults and parses migrate errors", () => {
  assert.deepEqual(getDefaultTelegramDc("test"), { id: 2, ip: "149.154.167.40", port: 443 });
  assert.deepEqual(getDefaultTelegramDc("production"), { id: 2, ip: "149.154.167.50", port: 443 });
  assert.equal(parseMigrateDc("PHONE_MIGRATE_5"), 5);
  assert.equal(parseMigrateDc("NETWORK_MIGRATE_4"), 4);
  assert.equal(parseMigrateDc("bad"), undefined);
});

test("AES-IGE wrapper matches GramJS IGE", () => {
  const key = hex("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");
  const iv = hex("00112233445566778899aabbccddeeffffeeddccbbaa99887766554433221100");
  const plain = hex("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");

  const encrypted = aesIgeEncrypt(plain, key, iv);
  assert.deepEqual(encrypted, gramjsAesIgeEncrypt(plain, key, iv));
  assert.deepEqual(aesIgeDecrypt(encrypted, key, iv), plain);
  assert.deepEqual(gramjsAesIgeDecrypt(encrypted, key, iv), plain);
});

test("PQInnerData serialization matches GramJS oracle", () => {
  const pq = hex("12724c21adf265ed");
  const p = hex("43af4637");
  const q = hex("45c4e2fb");
  const nonceBE = hex("93ee342c0b828711a3a0486eee98acd0");
  const serverNonceLE = hex("e55ca249b0d2d4ece32f3fd27d1c1f3c");
  const newNonceLE = hex("00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff");

  const local = serializeTLObject(new Api.PQInnerData({
    pq: Buffer.from(pq),
    p: Buffer.from(p),
    q: Buffer.from(q),
    nonce: tlBigIntFromBytesBE(nonceBE),
    serverNonce: tlBigIntFromBytesLE(serverNonceLE),
    newNonce: tlBigIntFromBytesLE(newNonceLE),
  }));

  assert.deepEqual(local, gramjsSerializePqInnerData({ pq, p, q, nonceBE, serverNonceLE, newNonceLE }));
});

test("ClientDHInnerData serialization matches GramJS oracle", () => {
  const nonceBE = hex("93ee342c0b828711a3a0486eee98acd0");
  const serverNonceLE = hex("e55ca249b0d2d4ece32f3fd27d1c1f3c");
  const gB = hex("04".padStart(512, "0"));

  const local = serializeTLObject(new Api.ClientDHInnerData({
    nonce: tlBigIntFromBytesBE(nonceBE),
    serverNonce: tlBigIntFromBytesLE(serverNonceLE),
    retryId: 0,
    gB: Buffer.from(gB),
  }));

  assert.deepEqual(local, gramjsSerializeClientDhInnerData({ nonceBE, serverNonceLE, gB }));
});

test("temporary AES key derivation matches GramJS", async () => {
  const newNonceLE = hex("00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff");
  const serverNonceLE = hex("e55ca249b0d2d4ece32f3fd27d1c1f3c");

  const hash1 = sha1(concatBytes(newNonceLE, serverNonceLE));
  const hash2 = sha1(concatBytes(serverNonceLE, newNonceLE));
  const hash3 = sha1(concatBytes(newNonceLE, newNonceLE));
  const local = {
    key: concatBytes(hash1, hash2.slice(0, 12)),
    iv: concatBytes(hash2.slice(12, 20), hash3, newNonceLE.slice(0, 4)),
  };

  const oracle = await gramjsDeriveTempAesKeyIv(serverNonceLE, newNonceLE);
  assert.deepEqual(local.key, oracle.key);
  assert.deepEqual(local.iv, oracle.iv);
});

test("message AES key derivation matches GramJS", async () => {
  const authKey = hex("00112233445566778899aabbccddeeff".repeat(16));
  const msgKey = hex("ffeeddccbbaa99887766554433221100");

  const localClient = deriveAesKeyIv(authKey, msgKey, true);
  const localServer = deriveAesKeyIv(authKey, msgKey, false);
  const oracleClient = await gramjsDeriveMessageAesKeyIv(authKey, msgKey, true);
  const oracleServer = await gramjsDeriveMessageAesKeyIv(authKey, msgKey, false);

  assert.deepEqual(localClient.aesKey, oracleClient.aesKey);
  assert.deepEqual(localClient.aesIv, oracleClient.aesIv);
  assert.deepEqual(localServer.aesKey, oracleServer.aesKey);
  assert.deepEqual(localServer.aesIv, oracleServer.aesIv);
});

test("xor helper stays aligned", () => {
  const left = hex("0011223344556677");
  const right = hex("8899aabbccddeeff");
  assert.deepEqual(xorBytes(left, right), hex("8888888888888888"));
});
