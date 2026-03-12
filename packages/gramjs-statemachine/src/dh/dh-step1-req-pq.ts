/**
 * DH Step 1: Build req_pq_multi
 *
 * Generates a 16-byte nonce and sends ReqPqMulti to the server.
 */

import { generateRandomBytes } from 'telegram/Helpers.js';
import { Api } from 'telegram/tl/index.js';

import type { SerializedState } from '../types/state.js';
import type { StepResult } from '../types/step-result.js';
import { wrapTransportFrame } from '../framing/intermediate-codec.js';
import { wrapPlainMessage } from '../framing/plain-message.js';
import { toHex } from '../session/crypto.js';
import { bigIntFromBytesBE } from '../session/bigint-helpers.js';

export function buildReqPqMultiFrame(
  state: SerializedState,
  nonce: Uint8Array,
): StepResult {
  // 1. Build ReqPqMulti TL object
  const reqPq = new Api.ReqPqMulti({
    nonce: bigIntFromBytesBE(nonce),
  });

  // 2. Serialize to bytes
  const body = new Uint8Array(reqPq.getBytes());

  // 3. Wrap in plain (unencrypted) message
  const previousMsgId = state.lastMsgId ? BigInt(state.lastMsgId) : 0n;
  const { message, msgId } = wrapPlainMessage(body, state.timeOffset, previousMsgId);

  // 4. Wrap in intermediate transport frame
  const outbound = wrapTransportFrame(message);

  // 5. Return result
  return {
    nextState: {
      ...state,
      phase: 'PQ_SENT',
      dhNonce: toHex(nonce),
      lastMsgId: msgId.toString(),
    },
    outbound,
    actions: [],
  };
}

export async function startDhExchange(state: SerializedState): Promise<StepResult> {
  const nonce = new Uint8Array(generateRandomBytes(16));
  const result = buildReqPqMultiFrame(state, nonce);
  console.debug('[gramjs-statemachine] startDhExchange', {
    phase: state.phase,
    dcId: state.dcId,
    nonceLength: nonce.length,
    outboundLength: result.outbound?.length ?? 0,
    nextMsgId: result.nextState.lastMsgId,
  });
  return result;
}
