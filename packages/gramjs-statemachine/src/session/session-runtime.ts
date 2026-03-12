import type { InternalAction } from '../types/internal-action.js';
import { createInitialState } from '../types/state.js';
import type { SerializedState } from '../types/state.js';
import type {
  AdvanceSessionResult,
  BeginAuthSessionResult,
} from '../types/session-result.js';
import type { SessionEvent } from '../types/session-event.js';
import type { ReconnectDirective } from '../types/transport-directive.js';
import { getDefaultTelegramDc, resolveTelegramDc } from '../dc/dc-resolver.js';
import { isQuickAck } from '../framing/intermediate-codec.js';
import { startDhExchange } from '../dh/dh-step1-req-pq.js';
import { step } from '../step.js';
import {
  checkPassword,
  exportQrToken,
  importLoginToken,
  sendCode,
  sendGetPassword,
  signIn,
} from '../auth/login-steps.js';
import type { StepResult } from '../types/step-result.js';

export interface BeginAuthSessionOptions {
  apiId: string;
  apiHash: string;
  dcMode?: 'production' | 'test';
  dcId?: number;
  authMode: 'phone' | 'qr';
  phone?: string;
}

function toErrorState(
  state: SerializedState,
  message: string,
  code?: number,
): SerializedState {
  if (state.phase === 'ERROR' && state.error?.message) {
    return state;
  }
  return {
    ...state,
    phase: 'ERROR',
    error: {
      message,
      code,
    },
  };
}

function detectServerErrorFrame(frame: Uint8Array): { code: number; message: string } | null {
  if (frame.length !== 8) {
    return null;
  }
  const inner = frame.slice(4);
  const view = new DataView(inner.buffer, inner.byteOffset, inner.byteLength);
  const code = view.getInt32(0, true);
  if (code >= 0) {
    return null;
  }
  return {
    code,
    message: `MTProto server error: ${code}`,
  };
}

function pushOutbound(
  outbox: Uint8Array[],
  result: Pick<StepResult, 'outbound'>,
): void {
  if (result.outbound) {
    outbox.push(result.outbound);
  }
}

function toSessionEvent(action: Extract<InternalAction, { type: 'rpc_result' | 'update' }>): SessionEvent {
  return action;
}

async function buildReconnectDirective(
  state: SerializedState,
  targetDcId: number,
  reason: ReconnectDirective['reason'],
  pendingQrImportTokenBase64Url?: string,
): Promise<ReconnectDirective> {
  const targetDc = resolveTelegramDc(state.dcMode, targetDcId);
  const resetState = createInitialState({
    dcMode: state.dcMode,
    dcId: targetDc.id,
    dcIp: targetDc.ip,
    dcPort: targetDc.port,
    apiId: state.apiId,
    apiHash: state.apiHash,
    authMode: state.authMode,
    phone: state.phone,
    pendingQrImportTokenBase64Url,
  });
  const dhResult = await startDhExchange(resetState);
  return {
    type: 'reconnect',
    reason,
    dcId: targetDc.id,
    dcIp: targetDc.ip,
    dcPort: targetDc.port,
    nextState: dhResult.nextState,
    firstOutbound: dhResult.outbound!,
  };
}

async function continueAuthReady(state: SerializedState): Promise<StepResult> {
  if (state.pendingQrImportTokenBase64Url) {
    return importLoginToken(state, {
      tokenBase64Url: state.pendingQrImportTokenBase64Url,
    });
  }
  if (state.authMode === 'qr') {
    return exportQrToken(state);
  }
  return sendCode(state);
}

async function handleInternalAction(
  state: SerializedState,
  action: InternalAction,
): Promise<{
  nextState: SerializedState;
  outbound?: Uint8Array;
  event?: SessionEvent;
  transport?: ReconnectDirective;
}> {
  switch (action.type) {
    case 'rpc_result':
    case 'update':
      return {
        nextState: state,
        event: toSessionEvent(action),
      };

    case 'auth_key_ready': {
      const followUp = await continueAuthReady(state);
      return {
        nextState: followUp.nextState,
        outbound: followUp.outbound,
      };
    }

    case 'login_qr_scanned': {
      const followUp = await exportQrToken(state);
      return {
        nextState: followUp.nextState,
        outbound: followUp.outbound,
      };
    }

    case 'login_qr_migrate': {
      const transport = await buildReconnectDirective(
        state,
        action.targetDcId,
        'dc_migrate',
        action.tokenBase64Url,
      );
      return {
        nextState: transport.nextState,
        transport,
      };
    }

    case 'dc_migrate': {
      const transport = await buildReconnectDirective(
        state,
        action.targetDcId,
        'dc_migrate',
        state.pendingQrImportTokenBase64Url,
      );
      return {
        nextState: transport.nextState,
        transport,
      };
    }

    case 'bad_msg':
      if (action.errorCode === 48) {
        if (state.phase === 'QR_TOKEN_SENT' || state.phase === 'AWAITING_QR_SCAN') {
          const followUp = await exportQrToken(state);
          return {
            nextState: followUp.nextState,
            outbound: followUp.outbound,
          };
        }
        if (state.phase === 'QR_IMPORT_SENT' && state.pendingQrImportTokenBase64Url) {
          const followUp = await importLoginToken(state, {
            tokenBase64Url: state.pendingQrImportTokenBase64Url,
          });
          return {
            nextState: followUp.nextState,
            outbound: followUp.outbound,
          };
        }
      }
      return { nextState: state };

    case 'error':
      if (action.message === 'AUTH_TOKEN_EXPIRED' && state.phase === 'QR_IMPORT_SENT') {
        const refreshed = {
          ...state,
          pendingQrImportTokenBase64Url: undefined,
          qrLoginUrl: undefined,
          qrExpiresAt: undefined,
        };
        const followUp = await exportQrToken(refreshed);
        return {
          nextState: followUp.nextState,
          outbound: followUp.outbound,
        };
      }
      if (
        action.message === 'SESSION_PASSWORD_NEEDED' &&
        (state.phase === 'QR_IMPORT_SENT' || state.phase === 'SIGN_IN_SENT')
      ) {
        const followUp = await sendGetPassword(state);
        return {
          nextState: followUp.nextState,
          outbound: followUp.outbound,
        };
      }
      if (action.message === 'AUTH_KEY_UNREGISTERED') {
        const transport = await buildReconnectDirective(
          {
            ...state,
            user: undefined,
            error: undefined,
            qrLoginUrl: undefined,
            qrExpiresAt: undefined,
            pendingRequests: {},
          },
          state.dcId,
          'auth_key_unregistered',
        );
        return {
          nextState: transport.nextState,
          transport,
        };
      }
      return {
        nextState: toErrorState(state, action.message, action.code),
      };

    case 'new_salt':
    case 'ack':
      return { nextState: state };

    default: {
      const _exhaustive: never = action;
      return { nextState: state, event: _exhaustive as never };
    }
  }
}

export async function beginAuthSession(
  opts: BeginAuthSessionOptions,
): Promise<BeginAuthSessionResult> {
  const dcMode = opts.dcMode ?? 'production';
  const targetDc = opts.dcId === undefined
    ? getDefaultTelegramDc(dcMode)
    : resolveTelegramDc(dcMode, opts.dcId);
  const initialState = createInitialState({
    apiId: opts.apiId,
    apiHash: opts.apiHash,
    dcMode,
    dcId: targetDc.id,
    dcIp: targetDc.ip,
    dcPort: targetDc.port,
    authMode: opts.authMode,
    phone: opts.authMode === 'phone' ? opts.phone?.trim() ?? '' : undefined,
  });
  const dhResult = await startDhExchange(initialState);
  return {
    nextState: dhResult.nextState,
    outbound: dhResult.outbound!,
    targetDc,
  };
}

export async function submitAuthCode(
  state: SerializedState,
  code: string,
): Promise<StepResult> {
  return signIn(state, { code: code.trim() });
}

export async function submitAuthPassword(
  state: SerializedState,
  password: string,
): Promise<StepResult> {
  return checkPassword(state, { password });
}

export async function refreshQrLogin(
  state: SerializedState,
): Promise<StepResult> {
  const refreshedState = state.phase === 'QR_IMPORT_SENT'
    ? {
        ...state,
        pendingQrImportTokenBase64Url: undefined,
        qrLoginUrl: undefined,
        qrExpiresAt: undefined,
      }
    : state;
  return exportQrToken(refreshedState);
}

export async function advanceSession(
  state: SerializedState,
  inbound: Uint8Array,
): Promise<AdvanceSessionResult> {
  if (state.phase === 'ERROR') {
    return {
      nextState: state,
      outbound: [],
      events: [],
    };
  }

  if (isQuickAck(inbound)) {
    return {
      nextState: state,
      outbound: [],
      events: [],
    };
  }

  const serverError = detectServerErrorFrame(inbound);
  if (serverError) {
    return {
      nextState: toErrorState(
        state,
        `${serverError.message} during ${state.phase}`,
        serverError.code,
      ),
      outbound: [],
      events: [],
    };
  }

  try {
    const stepped = await step(state, inbound);
    let nextState = stepped.nextState;
    const outbound: Uint8Array[] = [];
    const events: SessionEvent[] = [];
    let transport: ReconnectDirective | undefined;

    pushOutbound(outbound, stepped);

    for (const action of stepped.actions) {
      const handled = await handleInternalAction(nextState, action);
      nextState = handled.nextState;
      if (handled.outbound) {
        outbound.push(handled.outbound);
      }
      if (handled.event) {
        events.push(handled.event);
      }
      if (handled.transport) {
        transport = handled.transport;
      }
    }

    return {
      nextState,
      outbound,
      events,
      transport,
    };
  } catch (error) {
    return {
      nextState: toErrorState(
        state,
        error instanceof Error ? error.message : String(error),
      ),
      outbound: [],
      events: [],
    };
  }
}
