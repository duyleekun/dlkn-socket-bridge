/**
 * DH Step 2: Handle ResPQ → build req_DH_params
 *
 * Factorizes pq, RSA-encrypts PQInnerData, sends ReqDHParams.
 */

import bigInt from 'big-integer';
import { Factorizator } from 'telegram/crypto/Factorizator.js';
import { _serverKeys } from 'telegram/crypto/RSA.js';
import { generateRandomBytes, readBufferFromBigInt } from 'telegram/Helpers.js';
import { Api } from 'telegram/tl/index.js';
import { BinaryReader } from 'telegram/extensions/index.js';

import type { SerializedState } from '../types/state.js';
import type { StepResult } from '../types/step-result.js';
import { wrapTransportFrame } from '../framing/intermediate-codec.js';
import { stripTransportFrame } from '../framing/intermediate-codec.js';
import { wrapPlainMessage, unwrapPlainMessage } from '../framing/plain-message.js';
import { rsaEncryptMtproto2, toHex, fromHex } from '../session/crypto.js';
import {
  bigIntFromBytesBE,
  bigIntFromBytesLE,
  bigIntToBytesLE,
  bigIntToBytesBE,
  fingerprintToHex,
} from '../session/bigint-helpers.js';

export async function handleResPq(
  state: SerializedState,
  inbound: Uint8Array,
): Promise<StepResult> {
  // 1. Strip transport frame
  const stripped = stripTransportFrame(inbound);

  // 2. Unwrap plain message
  const { body } = unwrapPlainMessage(stripped);

  // 3. Deserialize ResPQ
  const reader = new BinaryReader(Buffer.from(body));
  const resPq = await Promise.resolve(
    reader.tgReadObject(),
  ) as InstanceType<typeof Api.ResPQ>;
  console.debug('[gramjs-statemachine] handleResPq', {
    phase: state.phase,
    inboundFrameLength: inbound.length,
    plainBodyLength: body.length,
    currentMsgId: state.lastMsgId,
  });

  const newNonceBytes = new Uint8Array(generateRandomBytes(32));
  return buildReqDhParams(state, resPq, newNonceBytes);
}

export function buildReqDhParams(
  state: SerializedState,
  resPq: InstanceType<typeof Api.ResPQ>,
  newNonceBytes: Uint8Array,
  randomBytes?: (size: number) => Uint8Array,
): StepResult {
  // 4. Extract server nonce as LE bytes
  const serverNonce = bigIntToBytesLE(resPq.serverNonce, 16);

  // 5. Factorize pq
  const pqBuf = new Uint8Array(resPq.pq as unknown as Buffer);
  const pqInt = bigIntFromBytesBE(pqBuf);
  const { p, q } = Factorizator.factorize(pqInt);
  const pBytes = new Uint8Array(readBufferFromBigInt(p, 4, false, false));
  const qBytes = new Uint8Array(readBufferFromBigInt(q, 4, false, false));

  // 6. Find matching RSA fingerprint
  const fingerprints = resPq.serverPublicKeyFingerprints;
  let matchedFp: ReturnType<typeof bigInt> | undefined;
  let matchedFpHex = '';

  for (const fp of fingerprints) {
    const hex = fingerprintToHex(fp);
    if (_serverKeys.has(fp.toString())) {
      matchedFp = fp;
      matchedFpHex = hex;
      break;
    }
  }

  if (!matchedFp) {
    const fpList = fingerprints.map((f: ReturnType<typeof bigInt>) => fingerprintToHex(f)).join(', ');
    throw new Error(`no matching RSA fingerprint found among: ${fpList}`);
  }

  // 7. Recover our nonce from state
  const nonce = fromHex(state.dhNonce!);
  const nonceBig = bigIntFromBytesBE(nonce);

  // 8. Convert the generated new_nonce into the LE integer representation
  // expected by GramJS' int256 serializer.
  const newNonceBig = bigIntFromBytesLE(newNonceBytes);

  // 9. Build PQInnerData
  const innerData = new Api.PQInnerData({
    pq: Buffer.from(pqBuf),
    p: Buffer.from(pBytes),
    q: Buffer.from(qBytes),
    nonce: nonceBig,
    serverNonce: resPq.serverNonce,
    newNonce: newNonceBig,
  });

  const innerDataBytes = new Uint8Array(innerData.getBytes());

  // 10. RSA encrypt the inner data. We keep the local helper here so the DH
  // step remains explicit and independently testable inside the state machine.
  // Characterization tests show the resulting ReqDHParams body matches stock
  // GramJS Authenticator under fixed entropy.
  const encryptedData = rsaEncryptMtproto2(innerDataBytes, matchedFpHex, randomBytes);

  // 11. Build ReqDHParams
  const reqDH = new Api.ReqDHParams({
    nonce: nonceBig,
    serverNonce: resPq.serverNonce,
    p: Buffer.from(pBytes),
    q: Buffer.from(qBytes),
    publicKeyFingerprint: matchedFp,
    encryptedData: Buffer.from(encryptedData),
  });

  const reqDHBody = new Uint8Array(reqDH.getBytes());
  const previousMsgId = state.lastMsgId ? BigInt(state.lastMsgId) : 0n;
  const { message, msgId } = wrapPlainMessage(reqDHBody, state.timeOffset, previousMsgId);
  const outbound = wrapTransportFrame(message);
  console.debug('[gramjs-statemachine] req_DH_params built', {
    fingerprint: matchedFpHex,
    pqLength: pqBuf.length,
    outboundLength: outbound.length,
    nextMsgId: msgId.toString(),
  });

  // 12. Return updated state
  return {
    nextState: {
      ...state,
      phase: 'DH_SENT',
      dhServerNonce: toHex(serverNonce),
      dhNewNonce: toHex(newNonceBytes),
      lastMsgId: msgId.toString(),
    },
    outbound,
    actions: [],
  };
}
