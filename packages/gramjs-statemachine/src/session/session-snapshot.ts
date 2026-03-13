import type { SerializedState as LegacySessionState } from '../types/state.js';

export type SessionProtocolPhase = LegacySessionState['phase'];

export type SessionStateValue =
  | 'handshake'
  | 'authorizing'
  | 'awaiting_code'
  | 'awaiting_password'
  | 'awaiting_qr_scan'
  | 'ready'
  | 'error';

export interface SessionContext extends Omit<LegacySessionState, 'version' | 'phase'> {
  protocolPhase: SessionProtocolPhase;
}

export interface SessionSnapshot {
  version: 2;
  value: SessionStateValue;
  context: SessionContext;
}

export interface CreateSessionInput {
  apiId: string;
  apiHash: string;
  dcMode?: 'production' | 'test';
  dcId?: number;
  authMode: 'phone' | 'qr';
  phone?: string;
}

export type SessionHostEvent =
  | {
      type: 'inbound_frame';
      frame: Uint8Array;
    }
  | {
      type: 'submit_code';
      code: string;
    }
  | {
      type: 'submit_password';
      password: string;
    }
  | {
      type: 'refresh_qr';
    };

export function deriveSessionStateValue(
  phase: SessionProtocolPhase,
): SessionStateValue {
  switch (phase) {
    case 'INIT':
    case 'PQ_SENT':
    case 'DH_SENT':
    case 'DH_GEN_SENT':
      return 'handshake';

    case 'AUTH_KEY_READY':
    case 'CODE_SENT':
    case 'SIGN_IN_SENT':
    case 'PASSWORD_INFO_SENT':
    case 'CHECK_PASSWORD_SENT':
    case 'QR_TOKEN_SENT':
    case 'QR_IMPORT_SENT':
      return 'authorizing';

    case 'AWAITING_CODE':
      return 'awaiting_code';

    case 'AWAITING_PASSWORD':
      return 'awaiting_password';

    case 'AWAITING_QR_SCAN':
      return 'awaiting_qr_scan';

    case 'READY':
      return 'ready';

    case 'ERROR':
      return 'error';

    default: {
      const _exhaustive: never = phase;
      return _exhaustive;
    }
  }
}

export function createSessionSnapshotFromLegacy(
  state: LegacySessionState,
): SessionSnapshot {
  const { version: _version, phase, ...context } = state;
  return {
    version: 2,
    value: deriveSessionStateValue(phase),
    context: {
      ...context,
      protocolPhase: phase,
    },
  };
}

export function toLegacySessionState(
  snapshot: SessionSnapshot,
): LegacySessionState {
  const { protocolPhase, ...context } = snapshot.context;
  return {
    version: 1,
    phase: protocolPhase,
    ...context,
  };
}
