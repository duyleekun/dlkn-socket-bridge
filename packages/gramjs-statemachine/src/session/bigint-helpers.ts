/**
 * BigInteger helpers bridging gramjs BigInteger (big-integer) and native bigint.
 *
 * GramJS uses the `big-integer` npm package for int128/int256/long TL fields.
 * Our state stores values as hex strings. These helpers convert between them.
 */

import bigInt from 'big-integer';
import type { BigInteger } from 'big-integer';
import { readBigIntFromBuffer, readBufferFromBigInt } from 'telegram/Helpers.js';

/** Read a GramJS BigInteger from a big-endian byte array */
export function bigIntFromBytesBE(bytes: Uint8Array): BigInteger {
  return readBigIntFromBuffer(Buffer.from(bytes), false, true);
}

/** Read a GramJS BigInteger from a little-endian byte array */
export function bigIntFromBytesLE(bytes: Uint8Array): BigInteger {
  return readBigIntFromBuffer(Buffer.from(bytes), true, true);
}

/** Convert a GramJS BigInteger back to LE bytes */
export function bigIntToBytesLE(num: BigInteger, length: number): Uint8Array {
  return new Uint8Array(readBufferFromBigInt(num, length, true, true));
}

/** Convert a GramJS BigInteger back to BE bytes */
export function bigIntToBytesBE(num: BigInteger, length: number): Uint8Array {
  return new Uint8Array(readBufferFromBigInt(num, length, false, true));
}

/**
 * Convert a GramJS fingerprint BigInteger to a lowercase hex string.
 * Handles negative values (two's complement to unsigned).
 */
export function fingerprintToHex(fp: BigInteger): string {
  // Use 2^64 to convert potential negative value to unsigned
  const two64 = readBigIntFromBuffer(
    Buffer.from('0000000000000001', 'hex'),
    false,
    false,
  ).shiftLeft(64);
  const unsigned = fp.isNegative() ? fp.add(two64) : fp;
  return unsigned.toString(16).padStart(16, '0');
}

export { bigInt };
export type { BigInteger };
