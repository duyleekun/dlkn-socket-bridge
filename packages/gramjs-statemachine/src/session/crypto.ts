/**
 * Crypto helpers for MTProto 2.0 message encryption/decryption.
 *
 * Uses GramJS IGE helpers for encrypted message transport and preserves the
 * project's older MTProto 2.0 RSA padding for DH setup compatibility.
 */

import { createHash } from 'node:crypto';
import bigInt from 'big-integer';
import { IGE } from 'telegram/crypto/IGE.js';
import { _serverKeys as gramjsServerKeys } from 'telegram/crypto/RSA.js';
import {
  sha1 as telegramSha1,
  sha256 as telegramSha256,
  generateRandomBytes,
  readBigIntFromBuffer,
  readBufferFromBigInt,
} from 'telegram/Helpers.js';
import { generateMessageId } from '../framing/plain-message.js';

// ── Hex helpers ──────────────────────────────────────────────────────────────

export function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

export function fromHex(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

// ── AES-256-IGE ──────────────────────────────────────────────────────────────

export function aesIgeEncrypt(
  data: Uint8Array,
  key: Uint8Array,
  iv: Uint8Array,
): Uint8Array {
  return new Uint8Array(
    new IGE(Buffer.from(key), Buffer.from(iv)).encryptIge(Buffer.from(data)),
  );
}

export function aesIgeDecrypt(
  data: Uint8Array,
  key: Uint8Array,
  iv: Uint8Array,
): Uint8Array {
  return new Uint8Array(
    new IGE(Buffer.from(key), Buffer.from(iv)).decryptIge(Buffer.from(data)),
  );
}

// ── MTProto 2.0 RSA padding (DH setup) ──────────────────────────────────────

const TELEGRAM_RSA_KEYS = new Map<
  string,
  { n: ReturnType<typeof bigInt>; e: ReturnType<typeof bigInt> }
>();

for (const [fingerprint, key] of gramjsServerKeys.entries()) {
  const signedFingerprint = bigInt(fingerprint);
  const two64 = bigInt('10000000000000000', 16);
  const unsignedFingerprint = signedFingerprint.isNegative()
    ? signedFingerprint.add(two64)
    : signedFingerprint;

  TELEGRAM_RSA_KEYS.set(unsignedFingerprint.toString(16).padStart(16, '0'), {
    n: bigInt(key.n),
    e: bigInt(key.e),
  });
}

function sha1Sync(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha1').update(data).digest());
}

function sha256Sync(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha256').update(data).digest());
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

function xorBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.length !== right.length) {
    throw new Error(`xorBytes length mismatch: ${left.length} !== ${right.length}`);
  }

  const result = new Uint8Array(left.length);
  for (let index = 0; index < left.length; index += 1) {
    result[index] = left[index]! ^ right[index]!;
  }
  return result;
}

function bigIntFromBytes(bytes: Uint8Array): ReturnType<typeof bigInt> {
  return readBigIntFromBuffer(Buffer.from(bytes), false, false);
}

function bigIntToBytes(
  value: ReturnType<typeof bigInt>,
  length: number,
): Uint8Array {
  return new Uint8Array(readBufferFromBigInt(value, length, false, false));
}

function defaultRandomBytes(size: number): Uint8Array {
  return new Uint8Array(generateRandomBytes(size));
}

/**
 * MTProto 2.0 RSA padding used during DH setup.
 *
 * GramJS' generic RSA helper produces a server-rejected `req_DH_params` for the
 * refactored flow, so we intentionally preserve the older project-specific
 * padding that previously worked against Telegram.
 */
export function rsaEncryptMtproto2(
  data: Uint8Array,
  fingerprintHex: string,
  randomBytes: (size: number) => Uint8Array = defaultRandomBytes,
): Uint8Array {
  const key = TELEGRAM_RSA_KEYS.get(fingerprintHex);
  if (!key) {
    throw new Error(`unknown RSA key fingerprint: ${fingerprintHex}`);
  }
  if (data.length > 144) {
    throw new Error(`rsaEncryptMtproto2: data too long (${data.length} > 144)`);
  }

  const padding = randomBytes(192 - data.length);
  const dataWithPadding = concatBytes(data, padding);
  const dataPadReversed = dataWithPadding.slice().reverse();

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const tempKey = randomBytes(32);
    const shaDigest = sha256Sync(concatBytes(tempKey, dataWithPadding));
    const dataWithHash = concatBytes(dataPadReversed, shaDigest);
    const aesEncrypted = aesIgeEncrypt(dataWithHash, tempKey, new Uint8Array(32));
    const tempKeyXor = xorBytes(tempKey, sha256Sync(aesEncrypted));
    const keyAesEncrypted = concatBytes(tempKeyXor, aesEncrypted);
    const keyAesInt = bigIntFromBytes(keyAesEncrypted);

    if (keyAesInt.greaterOrEquals(key.n)) {
      continue;
    }

    const encrypted = keyAesInt.modPow(key.e, key.n);
    return bigIntToBytes(encrypted, 256);
  }

  throw new Error('rsaEncryptMtproto2: failed to find valid padding after 20 retries');
}

// ── MTProto 2.0 message key derivation ───────────────────────────────────────

/**
 * Derive AES key + IV for MTProto 2.0 encryption/decryption.
 *
 * @param authKey 256-byte auth key
 * @param msgKey 16-byte message key
 * @param isClient true → client→server (x=0), false → server→client (x=8)
 */
export async function deriveAesKeyIv(
  authKey: Uint8Array,
  msgKey: Uint8Array,
  isClient: boolean,
): Promise<{ aesKey: Uint8Array; aesIv: Uint8Array }> {
  const x = isClient ? 0 : 8;

  const sha256a = await telegramSha256(
    Buffer.concat([Buffer.from(msgKey), Buffer.from(authKey.slice(x, x + 36))]),
  );
  const sha256b = await telegramSha256(
    Buffer.concat([Buffer.from(authKey.slice(40 + x, 40 + x + 36)), Buffer.from(msgKey)]),
  );

  const aesKey = new Uint8Array(
    Buffer.concat([sha256a.slice(0, 8), sha256b.slice(8, 24), sha256a.slice(24, 32)]),
  );
  const aesIv = new Uint8Array(
    Buffer.concat([sha256b.slice(0, 8), sha256a.slice(8, 24), sha256b.slice(24, 32)]),
  );

  return { aesKey, aesIv };
}

// ── MTProto 2.0 Encrypt ───────────────────────────────────────────────────────

export interface EncryptResult {
  encrypted: Uint8Array;
  msgId: bigint;
}

/**
 * Encrypt a message for sending to Telegram.
 */
export async function encryptMessage(opts: {
  authKey: Uint8Array;
  serverSalt: Uint8Array;
  sessionId: Uint8Array;
  seqNo: number;
  body: Uint8Array;
  timeOffset?: number;
  lastMsgId?: bigint;
}): Promise<EncryptResult> {
  const { authKey, serverSalt, sessionId, seqNo, body } = opts;
  const msgId = generateMessageId(opts.timeOffset ?? 0, opts.lastMsgId ?? 0n);

  // Build plaintext header (32 bytes)
  const header = new Uint8Array(32);
  const hv = new DataView(header.buffer);
  header.set(serverSalt, 0);          // 8 bytes
  header.set(sessionId, 8);           // 8 bytes
  hv.setBigUint64(16, msgId, true);   // 8 bytes
  hv.setUint32(24, seqNo, true);      // 4 bytes
  hv.setUint32(28, body.length, true); // 4 bytes

  const plainNopad = new Uint8Array(header.length + body.length);
  plainNopad.set(header, 0);
  plainNopad.set(body, header.length);

  // Padding: total must be multiple of 16, between 12 and 1024 bytes
  const padNeeded = 16 - (plainNopad.length % 16);
  const padding = padNeeded < 12 ? padNeeded + 16 : padNeeded;
  const randPad = new Uint8Array(await generateRandomBytes(padding));

  const plain = new Uint8Array(plainNopad.length + randPad.length);
  plain.set(plainNopad, 0);
  plain.set(randPad, plainNopad.length);

  // msg_key = middle 128 bits of sha256(authKey[88..120] + plain)
  const msgKeyFull = await telegramSha256(
    Buffer.concat([Buffer.from(authKey.slice(88, 120)), Buffer.from(plain)]),
  );
  const msgKey = new Uint8Array(msgKeyFull.slice(8, 24));

  const { aesKey, aesIv } = await deriveAesKeyIv(authKey, msgKey, true);
  const encryptedData = aesIgeEncrypt(plain, aesKey, aesIv);

  // auth_key_id = sha1(auth_key)[12..20]
  const authKeyIdBytes = new Uint8Array((await telegramSha1(Buffer.from(authKey))).slice(12, 20));

  const encrypted = new Uint8Array(authKeyIdBytes.length + msgKey.length + encryptedData.length);
  encrypted.set(authKeyIdBytes, 0);
  encrypted.set(msgKey, authKeyIdBytes.length);
  encrypted.set(encryptedData, authKeyIdBytes.length + msgKey.length);

  return { encrypted, msgId };
}

// ── MTProto 2.0 Decrypt ───────────────────────────────────────────────────────

export interface DecryptResult {
  body: Uint8Array;
  msgId: bigint;
  seqNo: number;
  salt: Uint8Array;
  sessionId: Uint8Array;
}

/**
 * Decrypt a message received from Telegram.
 */
export async function decryptMessage(opts: {
  authKey: Uint8Array;
  data: Uint8Array;
}): Promise<DecryptResult> {
  const { authKey, data } = opts;

  if (data.length < 24) {
    throw new Error(`encrypted message too short: ${data.length} bytes`);
  }

  const authKeyId = data.slice(0, 8);
  const msgKey = data.slice(8, 24);
  const encryptedData = data.slice(24);

  // Verify auth_key_id
  const expectedAuthKeyId = new Uint8Array(
    (await telegramSha1(Buffer.from(authKey))).slice(12, 20),
  );
  for (let i = 0; i < 8; i++) {
    if (authKeyId[i] !== expectedAuthKeyId[i]) {
      throw new Error('encrypted message auth_key_id mismatch');
    }
  }

  const { aesKey, aesIv } = await deriveAesKeyIv(authKey, msgKey, false);
  const plain = aesIgeDecrypt(encryptedData, aesKey, aesIv);

  // Verify msg_key
  const expectedMsgKey = new Uint8Array(
    (await telegramSha256(Buffer.concat([Buffer.from(authKey.slice(96, 128)), Buffer.from(plain)]))).slice(8, 24),
  );
  for (let i = 0; i < 16; i++) {
    if (msgKey[i] !== expectedMsgKey[i]) {
      throw new Error('encrypted message msg_key mismatch');
    }
  }

  const view = new DataView(plain.buffer, plain.byteOffset, plain.byteLength);
  const salt = plain.slice(0, 8);
  const sessionId = plain.slice(8, 16);
  const msgId = view.getBigUint64(16, true);
  const seqNo = view.getUint32(24, true);
  const bodyLength = view.getUint32(28, true);

  if (bodyLength > plain.length - 32) {
    throw new Error(
      `encrypted message body truncated: expected ${bodyLength}, got ${plain.length - 32}`,
    );
  }

  const body = plain.slice(32, 32 + bodyLength);
  return { body, msgId, seqNo, salt, sessionId };
}

// ── SHA helpers ───────────────────────────────────────────────────────────────

export async function sha1Bytes(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await telegramSha1(Buffer.from(data)));
}

export async function sha256Bytes(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await telegramSha256(Buffer.from(data)));
}

export { generateRandomBytes };
