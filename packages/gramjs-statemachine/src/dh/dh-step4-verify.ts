/**
 * DH Step 4: Handle DH gen result (DhGenOk / DhGenRetry / DhGenFail)
 *
 * Verifies the auth key, generates session ID, and transitions to AUTH_KEY_READY.
 */

import { generateRandomBytes } from 'telegram/Helpers.js';

import type { SerializedState } from '../types/state.js';
import type { StepResult } from '../types/step-result.js';
import { stripTransportFrame } from '../framing/intermediate-codec.js';
import { unwrapPlainMessage } from '../framing/plain-message.js';
import { toHex, fromHex } from '../session/crypto.js';
import { createGramJsAuthKey } from '../session/auth-key.js';
import { bigIntFromBytesLE } from '../session/bigint-helpers.js';
import { readTlObject } from '../tl/read-object.js';

export async function handleDhGenResult(
  state: SerializedState,
  inbound: Uint8Array,
): Promise<StepResult> {
  // 1. Strip transport frame + unwrap plain message + deserialize
  const stripped = stripTransportFrame(inbound);
  const { body } = unwrapPlainMessage(stripped);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await readTlObject(body) as any;

  if (result.className === 'DhGenOk') {
    // 2. Verify new_nonce_hash1
    if (!state.dhNewNonce || !state.authKey) {
      throw new Error('missing DH state for DhGenOk verification');
    }

    const { authKey } = createGramJsAuthKey(fromHex(state.authKey));

    const newNonceBigInt = bigIntFromBytesLE(fromHex(state.dhNewNonce));
    const expected = await authKey.calcNewNonceHash(newNonceBigInt, 1);

    if (!result.newNonceHash1?.equals(expected)) {
      throw new Error('DhGenOk new_nonce_hash1 mismatch');
    }

    // 3. Generate session ID (8 random bytes)
    const sessionId = new Uint8Array(generateRandomBytes(8));

    // 4. Transition to AUTH_KEY_READY
    return {
      nextState: {
        ...state,
        phase: 'AUTH_KEY_READY',
        sessionId: toHex(sessionId),
        sequence: 0,
        // Clear DH intermediates
        dhNonce: undefined,
        dhServerNonce: undefined,
        dhNewNonce: undefined,
      },
      actions: [{ type: 'auth_key_ready' }],
    };
  } else if (result.className === 'DhGenRetry') {
    throw new Error('DH gen retry requested — not implemented');
  } else if (result.className === 'DhGenFail') {
    throw new Error('DH gen failed');
  } else {
    throw new Error(`unexpected DH gen result: ${result.className}`);
  }
}
