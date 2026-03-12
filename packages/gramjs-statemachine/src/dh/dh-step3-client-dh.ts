/**
 * DH Step 3: Handle ServerDHParams → build set_client_DH_params
 *
 * Decrypts server DH inner data, computes g_b and auth_key,
 * encrypts ClientDHInnerData, sends SetClientDHParams.
 */

import bigInt from 'big-integer';
import {
  generateRandomBytes,
  generateKeyDataFromNonce,
  getByteArray,
  readBigIntFromBuffer,
  readBufferFromBigInt,
  sha1,
} from 'telegram/Helpers.js';
import { Api } from 'telegram/tl/index.js';
import { BinaryReader } from 'telegram/extensions/index.js';

import type { SerializedState } from '../types/state.js';
import type { StepResult } from '../types/step-result.js';
import { wrapTransportFrame, stripTransportFrame } from '../framing/intermediate-codec.js';
import { wrapPlainMessage, unwrapPlainMessage } from '../framing/plain-message.js';
import { toHex, fromHex, aesIgeEncrypt, aesIgeDecrypt } from '../session/crypto.js';
import { createGramJsAuthKey } from '../session/auth-key.js';
import {
  bigIntFromBytesBE,
  bigIntFromBytesLE,
} from '../session/bigint-helpers.js';

function bigIntFromBytesUnsignedBE(bytes: Uint8Array) {
  return readBigIntFromBuffer(Buffer.from(bytes), false, false);
}

function gramJsZeroBigInt() {
  return readBigIntFromBuffer(Buffer.alloc(8), true, true);
}

function defaultRandomBytes(size: number): Uint8Array {
  return new Uint8Array(generateRandomBytes(size));
}

function padToAesBlockSize(
  data: Uint8Array,
  randomBytes: (size: number) => Uint8Array,
): Uint8Array {
  const remainder = data.length % 16;
  if (remainder === 0) {
    return data;
  }
  const padding = randomBytes(16 - remainder);
  const padded = new Uint8Array(data.length + padding.length);
  padded.set(data, 0);
  padded.set(padding, data.length);
  return padded;
}

export async function handleServerDHParams(
  state: SerializedState,
  inbound: Uint8Array,
): Promise<StepResult> {
  // 1. Strip transport frame + unwrap plain message + deserialize
  const stripped = stripTransportFrame(inbound);
  const { body } = unwrapPlainMessage(stripped);
  const reader = new BinaryReader(Buffer.from(body));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dhParams = await Promise.resolve(reader.tgReadObject()) as any;
  console.debug('[gramjs-statemachine] handleServerDHParams', {
    phase: state.phase,
    inboundFrameLength: inbound.length,
    plainBodyLength: body.length,
    currentMsgId: state.lastMsgId,
  });

  return buildSetClientDhParams(state, dhParams);
}

export async function buildSetClientDhParams(
  state: SerializedState,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dhParams: any,
  randomBytes: (size: number) => Uint8Array = defaultRandomBytes,
  nowMs: number = Date.now(),
): Promise<StepResult> {

  if (dhParams.className !== 'ServerDHParamsOk') {
    throw new Error(`unexpected DH params response: ${dhParams.className}`);
  }

  // 2. Verify nonce + serverNonce match state
  const nonce = fromHex(state.dhNonce!);
  const nonceBig = bigIntFromBytesBE(nonce);
  const expectedServerNonce = bigIntFromBytesLE(fromHex(state.dhServerNonce!));

  if (dhParams.nonce.neq(nonceBig) || dhParams.serverNonce.neq(expectedServerNonce)) {
    throw new Error('server_DH_params nonce mismatch');
  }

  // 3. Derive temp AES key + IV using generateKeyDataFromNonce
  const serverNonceBigInt = bigIntFromBytesLE(fromHex(state.dhServerNonce!));
  const newNonceBigInt = bigIntFromBytesLE(fromHex(state.dhNewNonce!));
  const { key: tmpAesKey, iv: tmpAesIv } = await generateKeyDataFromNonce(
    serverNonceBigInt,
    newNonceBigInt,
  );

  // 4. AES-IGE decrypt encrypted answer
  const encryptedAnswer = new Uint8Array(dhParams.encryptedAnswer as Buffer);
  const decrypted = aesIgeDecrypt(
    encryptedAnswer,
    new Uint8Array(tmpAesKey),
    new Uint8Array(tmpAesIv),
  );

  // 5. Skip first 20 bytes (sha1 hash), deserialize ServerDHInnerData
  const innerReader = new BinaryReader(Buffer.from(decrypted.slice(20)));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const innerData = await Promise.resolve(innerReader.tgReadObject()) as any;

  // 6. Extract DH parameters
  const g: number = innerData.g;
  const dhPrimeBytes = new Uint8Array(innerData.dhPrime as Buffer);
  const gABytes = new Uint8Array(innerData.gA as Buffer);
  const serverTime: number = innerData.serverTime;

  // Calculate time offset
  const timeOffset = serverTime - Math.floor(nowMs / 1000);

  // 7. Generate b (256 random bytes), compute g_b and auth_key
  const b = randomBytes(256);

  // g^b mod dhPrime
  const gBigInt = bigInt(g);
  const bBigInt = bigIntFromBytesUnsignedBE(b);
  const dhPrimeBigInt = bigIntFromBytesUnsignedBE(dhPrimeBytes);
  const gB = gBigInt.modPow(bBigInt, dhPrimeBigInt);
  const gBBytes = new Uint8Array(getByteArray(gB, false));

  // gA^b mod dhPrime → auth_key
  const gABigInt = bigIntFromBytesUnsignedBE(gABytes);
  const authKeyBigInt = gABigInt.modPow(bBigInt, dhPrimeBigInt);
  const authKey = new Uint8Array(readBufferFromBigInt(authKeyBigInt, 256, false, false));
  const { keyIdBytes: authKeyId } = createGramJsAuthKey(authKey);

  // 8. Build ClientDHInnerData
  const clientInner = new Api.ClientDHInnerData({
    nonce: nonceBig,
    serverNonce: expectedServerNonce,
    retryId: gramJsZeroBigInt(),
    gB: Buffer.from(gBBytes),
  });

  const clientInnerBytes = new Uint8Array(clientInner.getBytes());
  const clientInnerHash = new Uint8Array(await sha1(Buffer.from(clientInnerBytes)));

  // Concat hash + data
  const dataWithHash = new Uint8Array(clientInnerHash.length + clientInnerBytes.length);
  dataWithHash.set(clientInnerHash, 0);
  dataWithHash.set(clientInnerBytes, clientInnerHash.length);

  // Encrypt with the same temp AES key/IV. We add the IGE block padding
  // explicitly so the state machine owns the random-byte stream rather than
  // relying on hidden padding inside the crypto helper.
  const paddedDataWithHash = padToAesBlockSize(dataWithHash, randomBytes);
  const encryptedData = aesIgeEncrypt(
    paddedDataWithHash,
    new Uint8Array(tmpAesKey),
    new Uint8Array(tmpAesIv),
  );

  // 9. Build SetClientDHParams
  const setDH = new Api.SetClientDHParams({
    nonce: nonceBig,
    serverNonce: expectedServerNonce,
    encryptedData: Buffer.from(encryptedData),
  });

  const setDHBody = new Uint8Array(setDH.getBytes());
  const previousMsgId = state.lastMsgId ? BigInt(state.lastMsgId) : 0n;
  const { message, msgId } = wrapPlainMessage(setDHBody, timeOffset, previousMsgId);
  const outbound = wrapTransportFrame(message);
  console.debug('[gramjs-statemachine] set_client_DH_params built', {
    serverTime,
    gBLength: gBBytes.length,
    outboundLength: outbound.length,
    nextMsgId: msgId.toString(),
  });

  // 10. Compute server_salt = newNonce[0..8] XOR serverNonce[0..8]
  const newNonce = fromHex(state.dhNewNonce!);
  const serverNonce = fromHex(state.dhServerNonce!);
  const serverSalt = new Uint8Array(8);
  for (let i = 0; i < 8; i++) {
    serverSalt[i] = newNonce[i] ^ serverNonce[i];
  }

  // 11. Return updated state
  return {
    nextState: {
      ...state,
      phase: 'DH_GEN_SENT',
      authKey: toHex(authKey),
      authKeyId: toHex(authKeyId),
      serverSalt: toHex(serverSalt),
      timeOffset,
      lastMsgId: msgId.toString(),
    },
    outbound,
    actions: [],
  };
}
