import { stripTransportFrame } from './framing/intermediate-codec.js';
import { hydrateMtProtoState } from './session/mtproto-session.js';
import { handleResPq } from './dh/dh-step2-server-dh.js';
import { handleServerDHParams } from './dh/dh-step3-client-dh.js';
import { handleDhGenResult } from './dh/dh-step4-verify.js';
import {
  dispatchDecodedObject,
  getTlObjectClassName,
} from './dispatch/inbound-dispatch.js';
import type { SerializedState } from './types/state.js';
import type { StepResult } from './types/step-result.js';

export async function step(
  state: SerializedState,
  inbound: Uint8Array,
): Promise<StepResult> {
  switch (state.phase) {
    case 'PQ_SENT':
      return handleResPq(state, inbound);

    case 'DH_SENT':
      return handleServerDHParams(state, inbound);

    case 'DH_GEN_SENT':
      return handleDhGenResult(state, inbound);

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

    case 'INIT':
      throw new Error(
        'Cannot call step() in INIT phase — call startDhExchange() first',
      );

    case 'ERROR':
      throw new Error(
        `Cannot step in ERROR phase: ${state.error?.message ?? 'unknown error'}`,
      );

    default: {
      const _exhaustive: never = state.phase;
      throw new Error(`Unknown phase: ${String(_exhaustive)}`);
    }
  }
}

async function stepEncrypted(
  state: SerializedState,
  inbound: Uint8Array,
): Promise<StepResult> {
  if (!state.authKey) {
    throw new Error('stepEncrypted called but authKey is missing from state');
  }

  const payload = stripTransportFrame(inbound);
  const mtprotoState = hydrateMtProtoState(state);
  const message = await mtprotoState.decryptMessageData(Buffer.from(payload));
  const msgId = BigInt(message.msgId.toString());
  const seqNo = (message as unknown as { seqNo: number }).seqNo;

  const { actions, updatedState, object, parsedRpc } = await dispatchDecodedObject(
    state,
    await Promise.resolve(message.obj),
    msgId,
    seqNo,
  );
  console.debug('[gramjs-statemachine] stepEncrypted', {
    phase: state.phase,
    inboundFrameLength: inbound.length,
    decryptedObjectClassName: getTlObjectClassName(object),
    msgId: msgId.toString(),
    seqNo,
    actionTypes: actions.map((action) => action.type),
    nextPhase: updatedState.phase,
  });
  return {
    nextState: updatedState,
    actions,
    decryptedFrame: {
      msgId: msgId.toString(),
      seqNo,
      object,
      requestName: parsedRpc?.requestName,
    },
  };
}
