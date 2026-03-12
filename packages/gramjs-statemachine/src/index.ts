/**
 * gramjs-statemachine — main entry point
 *
 * Public API:
 *   step(state, inbound)          — process one inbound frame
 *   startDhExchange(state)        — kick off DH key exchange (no inbound)
 *   sendApiRequest(state, req)    — encrypt + frame any API request
 *   sendCode / signIn / ...       — login helpers
 *   createInitialState(opts)      — factory for fresh state
 */

import { stripTransportFrame } from './framing/intermediate-codec.js';
import { hydrateMtProtoState } from './session/mtproto-session.js';
import { startDhExchange } from './dh/dh-step1-req-pq.js';
import { handleResPq } from './dh/dh-step2-server-dh.js';
import { handleServerDHParams } from './dh/dh-step3-client-dh.js';
import { handleDhGenResult } from './dh/dh-step4-verify.js';
import { dispatchDecodedObject } from './dispatch/inbound-dispatch.js';
import type { SerializedState } from './types/state.js';
import type { StepResult } from './types/step-result.js';

// ── Re-exports ────────────────────────────────────────────────────────────────

export type { SerializedState } from './types/state.js';
export type { Action } from './types/action.js';
export type { StepResult } from './types/step-result.js';
export { createInitialState } from './types/state.js';

export { startDhExchange } from './dh/dh-step1-req-pq.js';
export { Api } from 'telegram/tl/index.js';
export type { ApiMethodParams, ApiMethodPath } from './api/invoke.js';
export { sendApiMethod, sendApiRequest, randomLong } from './api/invoke.js';
export {
  sendCode,
  signIn,
  checkPassword,
  exportQrToken,
  importLoginToken,
  sendMsgsAck,
  sendGetPassword,
} from './auth/login-steps.js';
export { resolveTelegramDc, getDefaultTelegramDc, parseMigrateDc } from './dc/dc-resolver.js';
export { normalizeTlValue } from './dispatch/inbound-dispatch.js';

// ── Core step function ────────────────────────────────────────────────────────

/**
 * Process one inbound transport frame.
 *
 * Routes to the appropriate handler based on `state.phase`:
 * - DH phases (PQ_SENT, DH_SENT, DH_GEN_SENT): DH step handlers
 * - Post-auth phases (AUTH_KEY_READY … READY): decrypt + dispatch
 *
 * @param state   Current serialized state (loaded from storage)
 * @param inbound Raw bytes received from the bridge (one transport frame)
 * @returns       { nextState, outbound?, actions }
 */
export async function step(
  state: SerializedState,
  inbound: Uint8Array,
): Promise<StepResult> {
  switch (state.phase) {
    // ── DH key exchange phases ──────────────────────────────────────
    case 'PQ_SENT':
      return handleResPq(state, inbound);

    case 'DH_SENT':
      return handleServerDHParams(state, inbound);

    case 'DH_GEN_SENT':
      return handleDhGenResult(state, inbound);

    // ── Post-auth phases: decrypt + dispatch ────────────────────────
    case 'AUTH_KEY_READY':
    case 'CODE_SENT':
    case 'AWAITING_CODE':
    case 'SIGN_IN_SENT':
    case 'PASSWORD_INFO_SENT':
    case 'AWAITING_PASSWORD':
    case 'CHECK_PASSWORD_SENT':
    case 'QR_TOKEN_SENT':
    case 'AWAITING_QR_SCAN':
    case 'QR_IMPORT_SENT':
    case 'READY':
      return stepEncrypted(state, inbound);

    // ── Terminal / unexpected phases ────────────────────────────────
    case 'INIT':
      throw new Error(
        'Cannot call step() in INIT phase — call startDhExchange() first',
      );

    case 'ERROR':
      throw new Error(
        `Cannot step in ERROR phase: ${state.error?.message ?? 'unknown error'}`,
      );

    default: {
      // TypeScript exhaustiveness guard
      const _exhaustive: never = state.phase;
      throw new Error(`Unknown phase: ${String(_exhaustive)}`);
    }
  }
}

// ── Encrypted message step ────────────────────────────────────────────────────

async function stepEncrypted(
  state: SerializedState,
  inbound: Uint8Array,
): Promise<StepResult> {
  if (!state.authKey) {
    throw new Error('stepEncrypted called but authKey is missing from state');
  }

  // 1. Strip transport frame
  const payload = stripTransportFrame(inbound);

  // 2. Rehydrate GramJS state and let it parse the encrypted envelope.
  const mtprotoState = hydrateMtProtoState(state);
  const message = await mtprotoState.decryptMessageData(Buffer.from(payload));
  const object = await Promise.resolve(message.obj);
  const msgId = BigInt(message.msgId.toString());
  const seqNo = (message as unknown as { seqNo: number }).seqNo;

  // 3. Dispatch the decoded TL object through the existing reducer logic.
  const { actions, updatedState } = await dispatchDecodedObject(
    state,
    object,
    msgId,
    seqNo,
  );
  console.debug('[gramjs-statemachine] stepEncrypted', {
    phase: state.phase,
    inboundFrameLength: inbound.length,
    decryptedObjectClassName: (object as { className?: string } | null)?.className
      ?? (object as { constructor?: { name?: string } } | null)?.constructor?.name,
    msgId: msgId.toString(),
    seqNo,
    actionTypes: actions.map((action) => action.type),
    nextPhase: updatedState.phase,
  });
  return { nextState: updatedState, actions };
}
