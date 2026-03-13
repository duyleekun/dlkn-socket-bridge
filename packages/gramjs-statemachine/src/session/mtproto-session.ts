/**
 * Hydration/dehydration helpers for MTProto session state.
 *
 * These convert between our SerializedState (JSON-serializable, persistable)
 * and the runtime values needed for crypto operations.
 */

import bigInt from 'big-integer';
import { MTProtoState } from 'telegram/network/MTProtoState.js';
import { readBigIntFromBuffer } from 'telegram/Helpers.js';
import type { SerializedState } from '../types/state.js';
import { fromHex } from './crypto.js';
import { createGramJsAuthKey } from './auth-key.js';

/** Runtime MTProto session values hydrated from SerializedState */
export interface HydratedSession {
  authKey: Uint8Array;
  authKeyId: Uint8Array;
  serverSalt: Uint8Array;
  sessionId: Uint8Array;
  timeOffset: number;
  sequence: number;
  lastMsgId: bigint;
}

type NullLogger = {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  canSend: () => boolean;
};

export type RuntimeMtProtoState = MTProtoState & {
  writeDataAsMessage: (
    buffer: { write: (data: Buffer) => void },
    data: Buffer,
    contentRelated: boolean,
    afterId?: ReturnType<typeof bigInt>,
  ) => Promise<ReturnType<typeof bigInt>>;
  encryptMessageData: (data: Buffer) => Promise<Buffer>;
  decryptMessageData: (data: Buffer) => Promise<{
    msgId: ReturnType<typeof bigInt>;
    seqNo: number;
    obj: unknown;
  }>;
};

const NULL_LOGGER: NullLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  canSend() {
    return false;
  },
};

/**
 * Hydrate runtime values from a state that has completed DH exchange.
 * Throws if authKey, authKeyId, serverSalt, or sessionId are missing.
 */
export function hydrateSession(state: SerializedState): HydratedSession {
  if (!state.authKey) throw new Error('state.authKey is missing — DH not complete');
  if (!state.authKeyId) throw new Error('state.authKeyId is missing');
  if (!state.serverSalt) throw new Error('state.serverSalt is missing');
  if (!state.sessionId) throw new Error('state.sessionId is missing');

  return {
    authKey: fromHex(state.authKey),
    authKeyId: fromHex(state.authKeyId),
    serverSalt: fromHex(state.serverSalt),
    sessionId: fromHex(state.sessionId),
    timeOffset: state.timeOffset,
    sequence: state.sequence,
    lastMsgId: BigInt(state.lastMsgId),
  };
}

/**
 * Recreate GramJS' encrypted MTProto runtime state from serialized worker state.
 *
 * This keeps the Worker architecture stateless while still letting us reuse
 * GramJS' message-id, sequence, and encrypted envelope machinery.
 */
export function hydrateMtProtoState(
  state: SerializedState,
): RuntimeMtProtoState {
  const session = hydrateSession(state);
  const { authKey } = createGramJsAuthKey(session.authKey);

  const runtime = new MTProtoState(authKey, NULL_LOGGER) as RuntimeMtProtoState;
  const mutable = runtime as unknown as Record<string, unknown>;
  mutable.id = readBigIntFromBuffer(Buffer.from(session.sessionId), true, false);
  mutable.salt = readBigIntFromBuffer(Buffer.from(session.serverSalt), true, true);
  mutable.timeOffset = session.timeOffset;
  mutable._sequence = session.sequence;
  mutable._lastMsgId = bigInt(session.lastMsgId.toString());
  return runtime;
}

export function readMtProtoSequence(state: RuntimeMtProtoState): number {
  return (state as unknown as { _sequence: number })._sequence;
}

