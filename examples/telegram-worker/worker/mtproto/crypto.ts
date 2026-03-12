/**
 * MTProto crypto primitives.
 *
 * Hashes stay local and synchronous for the worker, while byte/IGE helpers
 * delegate to GramJS so the worker matches its MTProto wire behavior.
 */

import { createHash } from "node:crypto";
import bigInt, { type BigInteger } from "big-integer";
import { IGE } from "telegram/crypto/IGE";
import { _serverKeys as gramjsServerKeys } from "telegram/crypto/RSA";
import {
  bufferXor as gramjsBufferXor,
  generateRandomBytes as gramjsGenerateRandomBytes,
  readBigIntFromBuffer as gramjsReadBigIntFromBuffer,
  readBufferFromBigInt as gramjsReadBufferFromBigInt,
} from "telegram/Helpers";

// ─── Hash functions ───

export function sha1(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha1").update(data).digest());
}

export function sha256(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(data).digest());
}

// ─── Random bytes ───

export function generateNonce(length: number): Uint8Array {
  return new Uint8Array(gramjsGenerateRandomBytes(length));
}

// ─── AES-256-IGE ───

/**
 * AES-256-IGE encryption.
 * @param data plaintext (must be padded to 16-byte blocks)
 * @param key 32-byte AES key
 * @param iv 32-byte IV (first 16 = ivPart1, second 16 = ivPart2)
 */
export function aesIgeEncrypt(
  data: Uint8Array,
  key: Uint8Array,
  iv: Uint8Array,
): Uint8Array {
  if (data.length % 16 !== 0) {
    throw new Error(`aesIgeEncrypt: data length ${data.length} not multiple of 16`);
  }
  return new Uint8Array(
    new IGE(Buffer.from(key), Buffer.from(iv)).encryptIge(Buffer.from(data)),
  );
}

/**
 * AES-256-IGE decryption.
 * @param data ciphertext (must be padded to 16-byte blocks)
 * @param key 32-byte AES key
 * @param iv 32-byte IV (first 16 = ivPart1, second 16 = ivPart2)
 */
export function aesIgeDecrypt(
  data: Uint8Array,
  key: Uint8Array,
  iv: Uint8Array,
): Uint8Array {
  if (data.length % 16 !== 0) {
    throw new Error(`aesIgeDecrypt: data length ${data.length} not multiple of 16`);
  }
  return new Uint8Array(
    new IGE(Buffer.from(key), Buffer.from(iv)).decryptIge(Buffer.from(data)),
  );
}

// ─── XOR helper ───

/** XOR two equal-length Uint8Arrays. */
export function xorBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  return new Uint8Array(gramjsBufferXor(Buffer.from(a), Buffer.from(b)));
}

// ─── Little-endian BigInteger helpers ───

/**
 * Interpret bytes as a little-endian integer (for gramjs int128/int256 fields).
 * gramjs uses readBigIntFromBuffer(bytes, little=true), which means the first
 * byte is the least-significant. We reverse before calling bigIntFromBytes (BE).
 */
export function bigIntFromBytesLE(bytes: Uint8Array): BigInteger {
  return gramjsReadBigIntFromBuffer(Buffer.from(bytes), true, false);
}

/**
 * Convert BigInteger to little-endian bytes of given length.
 * bigIntToBytes is big-endian, so we reverse the result.
 */
export function bigIntToBytesLE(num: BigInteger, length: number): Uint8Array {
  return new Uint8Array(gramjsReadBufferFromBigInt(num, length, true, false));
}

/** GramJS-compatible signed big-endian int128/int256 conversion. */
export function tlBigIntFromBytesBE(bytes: Uint8Array): BigInteger {
  return gramjsReadBigIntFromBuffer(Buffer.from(bytes), false, true);
}

/** GramJS-compatible signed little-endian int128/int256 conversion. */
export function tlBigIntFromBytesLE(bytes: Uint8Array): BigInteger {
  return gramjsReadBigIntFromBuffer(Buffer.from(bytes), true, true);
}

/** GramJS-compatible signed little-endian byte encoding. */
export function tlBigIntToBytesLE(num: BigInteger, length: number): Uint8Array {
  return new Uint8Array(gramjsReadBufferFromBigInt(num, length, true, true));
}

/** Format a possibly signed int64 fingerprint the same way the worker sees it. */
export function fingerprintToHex(fp: BigInteger): string {
  const two64 = bigInt("10000000000000000", 16);
  const unsigned = fp.isNegative() ? fp.add(two64) : fp;
  return unsigned.toString(16).padStart(16, "0");
}

// ─── RSA ───

// Intentionally sourced from GramJS internals and protected by an exact
// `telegram` version pin in package.json.
const TELEGRAM_RSA_KEYS = new Map<string, { n: BigInteger; e: BigInteger }>();

for (const [fingerprint, key] of gramjsServerKeys.entries()) {
  TELEGRAM_RSA_KEYS.set(
    fingerprintToHex(bigInt(fingerprint)),
    {
      n: bigInt(key.n),
      e: bigInt(key.e),
    },
  );
}

export const KNOWN_RSA_FINGERPRINTS = [...TELEGRAM_RSA_KEYS.keys()];

/**
 * RSA-encrypt data using Telegram MTProto 2.0 padding scheme.
 *
 * Algorithm (from Telegram docs / gramjs Authenticator.js):
 *   data_with_padding = data ++ random_pad  (padded to 192 bytes)
 *   data_pad_reversed = reverse(data_with_padding)
 *   loop:
 *     temp_key = random(32)
 *     aes_encrypted = AES-IGE(data_pad_reversed ++ SHA256(temp_key ++ data_with_padding),
 *                             key=temp_key, iv=zeros(32))
 *     temp_key_xor = temp_key XOR SHA256(aes_encrypted)
 *     key_aes_encrypted = temp_key_xor ++ aes_encrypted   (256 bytes)
 *     if key_aes_encrypted_as_bigint >= n: retry
 *   encrypted_data = RSA_modpow(key_aes_encrypted, e, n)  (256 bytes)
 *
 * @param data  raw pqInnerData bytes (must be < 144 bytes)
 * @param fingerprint  the RSA key fingerprint (hex string)
 */
export function rsaEncryptMtproto2(
  data: Uint8Array,
  fingerprint: string,
): Uint8Array {
  const key = TELEGRAM_RSA_KEYS.get(fingerprint);
  if (!key) {
    throw new Error(`unknown RSA key fingerprint: ${fingerprint}`);
  }
  if (data.length > 144) {
    throw new Error(`rsaEncryptMtproto2: data too long (${data.length} > 144)`);
  }

  // Pad data to 192 bytes
  const padding = generateNonce(192 - data.length);
  const dataWithPadding = concatBytes(data, padding);           // 192 bytes
  const dataPadReversed = dataWithPadding.slice().reverse();    // 192 bytes

  const { n, e } = key;

  for (let i = 0; i < 20; i++) {
    const tempKey = generateNonce(32);
    // SHA256(temp_key ++ data_with_padding) — 32 bytes
    const shaDigest = sha256(concatBytes(tempKey, dataWithPadding));
    // AES-IGE input: data_pad_reversed (192) ++ sha_digest (32) = 224 bytes
    const dataWithHash = concatBytes(dataPadReversed, shaDigest);
    // AES-IGE with key=tempKey, iv=zeros(32)
    const aesEncrypted = aesIgeEncrypt(dataWithHash, tempKey, new Uint8Array(32));
    // temp_key_xor = temp_key XOR SHA256(aes_encrypted)
    const tempKeyXor = xorBytes(tempKey, sha256(aesEncrypted));
    // key_aes_encrypted = temp_key_xor (32) ++ aes_encrypted (224) = 256 bytes
    const keyAesEncrypted = concatBytes(tempKeyXor, aesEncrypted);

    const keyAesInt = bigIntFromBytes(keyAesEncrypted);
    if (keyAesInt.greaterOrEquals(n)) continue;

    const encrypted = keyAesInt.modPow(e, n);
    return bigIntToBytes(encrypted, 256);
  }
  throw new Error("rsaEncryptMtproto2: failed to find valid padding after 20 retries");
}

// ─── PQ factorization ───

/**
 * Factorize pq into p and q (p < q) using Pollard's rho algorithm.
 */
export function factorizePQ(pq: BigInteger): { p: BigInteger; q: BigInteger } {
  if (pq.isEven()) {
    const half = pq.divide(bigInt(2));
    return { p: bigInt(2), q: half };
  }

  // Pollard's rho
  for (let attempt = 0; attempt < 3; attempt++) {
    const c = bigInt(Buffer.from(generateNonce(8)).readBigUInt64BE().toString()).mod(pq.minus(1)).plus(1);
    let x = bigInt(Buffer.from(generateNonce(8)).readBigUInt64BE().toString()).mod(pq.minus(2)).plus(2);
    let y = x;
    let d = bigInt.one;

    while (d.equals(bigInt.one)) {
      x = x.multiply(x).plus(c).mod(pq);
      y = y.multiply(y).plus(c).mod(pq);
      y = y.multiply(y).plus(c).mod(pq);
      d = gcd(x.minus(y).abs(), pq);
    }

    if (!d.equals(pq)) {
      const other = pq.divide(d);
      const p = d.lesser(other) ? d : other;
      const q = d.lesser(other) ? other : d;
      return { p, q };
    }
  }

  throw new Error(`failed to factorize pq=${pq.toString()}`);
}

function gcd(a: BigInteger, b: BigInteger): BigInteger {
  while (!b.isZero()) {
    const t = b;
    b = a.mod(b);
    a = t;
  }
  return a;
}

// ─── DH computation ───

/**
 * Compute auth_key from DH exchange.
 * auth_key = g_a^b mod dh_prime (or g^(a*b) mod dh_prime)
 */
export function computeDHKey(
  gA: Uint8Array,
  b: Uint8Array,
  dhPrime: Uint8Array,
): Uint8Array {
  const gAInt = bigIntFromBytes(gA);
  const bInt = bigIntFromBytes(b);
  const primeInt = bigIntFromBytes(dhPrime);
  const authKeyInt = gAInt.modPow(bInt, primeInt);
  return bigIntToBytes(authKeyInt, 256);
}

/**
 * Compute g_b = g^b mod dh_prime
 */
export function computeGB(
  g: number,
  b: Uint8Array,
  dhPrime: Uint8Array,
): Uint8Array {
  const gInt = bigInt(g);
  const bInt = bigIntFromBytes(b);
  const primeInt = bigIntFromBytes(dhPrime);
  const gbInt = gInt.modPow(bInt, primeInt);
  return bigIntToBytes(gbInt, 256);
}

// ─── Helpers ───

/** Convert big-endian byte array to BigInteger. */
export function bigIntFromBytes(bytes: Uint8Array): BigInteger {
  return gramjsReadBigIntFromBuffer(Buffer.from(bytes), false, false);
}

/** Convert BigInteger to big-endian byte array of specified length. */
export function bigIntToBytes(num: BigInteger, length: number): Uint8Array {
  return new Uint8Array(gramjsReadBufferFromBigInt(num, length, false, false));
}

/** Concat multiple Uint8Arrays. */
export function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

/** Hex-encode bytes. */
export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Hex-decode string to bytes. */
export function fromHex(hex: string): Uint8Array {
  const result = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    result[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return result;
}
