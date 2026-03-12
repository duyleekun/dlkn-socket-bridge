import type { BigInteger } from "big-integer";
import { Api } from "./serializer";
import { IGE } from "telegram/crypto/IGE";
import {
  generateKeyDataFromNonce,
  readBigIntFromBuffer,
  readBufferFromBigInt,
  sha256,
} from "telegram/Helpers";

export function gramjsSignedBigIntFromBytesBE(bytes: Uint8Array): BigInteger {
  return readBigIntFromBuffer(Buffer.from(bytes), false, true);
}

export function gramjsSignedBigIntFromBytesLE(bytes: Uint8Array): BigInteger {
  return readBigIntFromBuffer(Buffer.from(bytes), true, true);
}

export function gramjsSignedBigIntToBytesLE(num: BigInteger, length: number): Uint8Array {
  return new Uint8Array(readBufferFromBigInt(num, length, true, true));
}

export function gramjsFingerprintToHex(fp: BigInteger): string {
  const two64 = readBigIntFromBuffer(Buffer.from("0000000000000001", "hex"), false, false).shiftLeft(64);
  const unsigned = fp.isNegative() ? fp.add(two64) : fp;
  return unsigned.toString(16).padStart(16, "0");
}

export function gramjsSerializePqInnerData(input: {
  pq: Uint8Array;
  p: Uint8Array;
  q: Uint8Array;
  nonceBE: Uint8Array;
  serverNonceLE: Uint8Array;
  newNonceLE: Uint8Array;
}): Uint8Array {
  return new Uint8Array(
    new Api.PQInnerData({
      pq: Buffer.from(input.pq),
      p: Buffer.from(input.p),
      q: Buffer.from(input.q),
      nonce: gramjsSignedBigIntFromBytesBE(input.nonceBE),
      serverNonce: gramjsSignedBigIntFromBytesLE(input.serverNonceLE),
      newNonce: gramjsSignedBigIntFromBytesLE(input.newNonceLE),
    }).getBytes(),
  );
}

export function gramjsSerializeClientDhInnerData(input: {
  nonceBE: Uint8Array;
  serverNonceLE: Uint8Array;
  gB: Uint8Array;
}): Uint8Array {
  return new Uint8Array(
    new Api.ClientDHInnerData({
      nonce: gramjsSignedBigIntFromBytesBE(input.nonceBE),
      serverNonce: gramjsSignedBigIntFromBytesLE(input.serverNonceLE),
      retryId: 0,
      gB: Buffer.from(input.gB),
    }).getBytes(),
  );
}

export async function gramjsDeriveTempAesKeyIv(
  serverNonceLE: Uint8Array,
  newNonceLE: Uint8Array,
): Promise<{ key: Uint8Array; iv: Uint8Array }> {
  const derived = await generateKeyDataFromNonce(
    gramjsSignedBigIntFromBytesLE(serverNonceLE),
    gramjsSignedBigIntFromBytesLE(newNonceLE),
  );
  return {
    key: new Uint8Array(derived.key),
    iv: new Uint8Array(derived.iv),
  };
}

export async function gramjsDeriveMessageAesKeyIv(
  authKey: Uint8Array,
  msgKey: Uint8Array,
  isClient: boolean,
): Promise<{ aesKey: Uint8Array; aesIv: Uint8Array }> {
  const x = isClient ? 0 : 8;
  const sha256a = await sha256(Buffer.concat([Buffer.from(msgKey), Buffer.from(authKey.slice(x, x + 36))]));
  const sha256b = await sha256(Buffer.concat([Buffer.from(authKey.slice(x + 40, x + 76)), Buffer.from(msgKey)]));
  return {
    aesKey: new Uint8Array(Buffer.concat([sha256a.slice(0, 8), sha256b.slice(8, 24), sha256a.slice(24, 32)])),
    aesIv: new Uint8Array(Buffer.concat([sha256b.slice(0, 8), sha256a.slice(8, 24), sha256b.slice(24, 32)])),
  };
}

export function gramjsAesIgeEncrypt(
  data: Uint8Array,
  key: Uint8Array,
  iv: Uint8Array,
): Uint8Array {
  return new Uint8Array(new IGE(Buffer.from(key), Buffer.from(iv)).encryptIge(Buffer.from(data)));
}

export function gramjsAesIgeDecrypt(
  data: Uint8Array,
  key: Uint8Array,
  iv: Uint8Array,
): Uint8Array {
  return new Uint8Array(new IGE(Buffer.from(key), Buffer.from(iv)).decryptIge(Buffer.from(data)));
}
