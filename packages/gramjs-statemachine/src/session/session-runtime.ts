import type { InternalAction } from '../types/internal-action.js';
import { createSessionTransitionResult } from 'shared-statemachine';
import { createInitialState } from '../types/state.js';
import type { SerializedState } from '../types/state.js';
import type {
  SessionTransitionResult,
} from '../types/session-result.js';
import type { SessionCommand } from '../types/session-command.js';
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
import {
  sendApiMethod,
  type ApiMethodParams,
  type ApiMethodPath,
} from '../api/invoke.js';
import type { StepResult } from '../types/step-result.js';
import type {
  CreateSessionInput,
  SessionHostEvent,
  SessionSnapshot,
} from './session-snapshot.js';
import {
  createSessionSnapshotFromLegacy,
  toLegacySessionState,
} from './session-snapshot.js';
import { selectSessionView } from './session-view.js';
import { runSessionMachine } from './session-machine.js';

interface BeginAuthSessionOptions {
  apiId: string;
  apiHash: string;
  dcMode?: 'production' | 'test';
  dcId?: number;
  authMode: 'phone' | 'qr';
  phone?: string;
}

function toSessionCommandOutbound(frame: Uint8Array): SessionCommand {
  return {
    type: 'send_frame',
    frame,
  };
}

function toSessionCommandReconnect(
  directive: ReconnectDirective,
): SessionCommand {
  return {
    type: 'reconnect',
    reason: directive.reason,
    dcId: directive.dcId,
    dcIp: directive.dcIp,
    dcPort: directive.dcPort,
    firstFrame: directive.firstOutbound,
  };
}

function toTransitionResult(
  nextState: SerializedState,
  outbound: Uint8Array[],
  events: SessionEvent[],
  transport?: ReconnectDirective,
): SessionTransitionResult {
  const snapshot = createSessionSnapshotFromLegacy(nextState);
  const commands: SessionCommand[] = [];
  if (transport) {
    commands.push(toSessionCommandReconnect(transport));
  }
  commands.push(...outbound.map(toSessionCommandOutbound));
  return createSessionTransitionResult(
    snapshot,
    commands,
    events,
    selectSessionView(snapshot),
  );
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

async function buildReconnectDirective(
  state: SerializedState,
  targetDcId: number,
  reason: ReconnectDirective['reason'],
  qrLoginUrl?: string,
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
    qrLoginUrl,
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
  const tokenBase64Url = resolveQrImportToken(state);
  if (tokenBase64Url) {
    return importLoginToken(state, {
      tokenBase64Url,
    });
  }
  if (state.authMode === 'qr') {
    return exportQrToken(state);
  }
  return sendCode(state);
}

function resolveQrImportToken(state: SerializedState): string | null {
  if (!state.qrLoginUrl) {
    return null;
  }

  try {
    return new URL(state.qrLoginUrl).searchParams.get('token');
  } catch {
    return null;
  }
}

async function handleInternalAction(
  state: SerializedState,
  action: InternalAction,
): Promise<{
  nextState: SerializedState;
  outbound?: Uint8Array;
  transport?: ReconnectDirective;
}> {
  switch (action.type) {
    case 'auth_key_ready': {
      const followUp = await continueAuthReady(state);
      return {
        nextState: followUp.nextState,
        outbound: followUp.outbound,
      };
    }

    case 'login_qr_scanned': {
      const tokenBase64Url = resolveQrImportToken(state);
      if (!tokenBase64Url) {
        return {
          nextState: toErrorState(state, 'missing QR import token'),
        };
      }

      const followUp = await importLoginToken(state, { tokenBase64Url });
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
        `tg://login?token=${action.tokenBase64Url}`,
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
        state.qrLoginUrl,
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
        if (state.phase === 'QR_IMPORT_SENT') {
          const tokenBase64Url = resolveQrImportToken(state);
          if (!tokenBase64Url) {
            return {
              nextState: toErrorState(state, 'missing QR import token'),
            };
          }
          const followUp = await importLoginToken(state, {
            tokenBase64Url,
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
      void _exhaustive;
      return { nextState: state };
    }
  }
}

async function beginAuthSession(
  opts: BeginAuthSessionOptions,
) {
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

async function submitAuthCode(
  state: SerializedState,
  code: string,
): Promise<StepResult> {
  return signIn(state, { code: code.trim() });
}

async function submitAuthPassword(
  state: SerializedState,
  password: string,
): Promise<StepResult> {
  return checkPassword(state, { password });
}

async function refreshQrLogin(
  state: SerializedState,
): Promise<StepResult> {
  const refreshedState = state.phase === 'QR_IMPORT_SENT'
    ? {
        ...state,
        qrLoginUrl: undefined,
        qrExpiresAt: undefined,
      }
    : state;
  return exportQrToken(refreshedState);
}

async function advanceSession(
  state: SerializedState,
  inbound: Uint8Array,
) {
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
      if (handled.transport) {
        transport = handled.transport;
      }
    }

    if (stepped.decryptedFrame) {
      events.push({
        type: 'decrypted_frame',
        ...stepped.decryptedFrame,
      });
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

export async function createSession(
  input: CreateSessionInput,
): Promise<SessionTransitionResult> {
  const initial = await beginAuthSession(input);
  return toTransitionResult(initial.nextState, [initial.outbound], []);
}

async function applySessionHostEvent(
  snapshot: SessionSnapshot,
  event: SessionHostEvent,
): Promise<{
  snapshot: SessionSnapshot;
  commands: SessionCommand[];
  events: SessionEvent[];
}> {
  const state = toLegacySessionState(snapshot);

  switch (event.type) {
    case 'inbound_frame': {
      const result = await advanceSession(state, event.frame);
      const next = toTransitionResult(
        result.nextState,
        result.outbound,
        result.events,
        result.transport,
      );
      return {
        snapshot: next.snapshot,
        commands: next.commands,
        events: next.events,
      };
    }

    case 'submit_code': {
      const result = await submitAuthCode(state, event.code);
      return {
        snapshot: createSessionSnapshotFromLegacy(result.nextState),
        commands: result.outbound ? [toSessionCommandOutbound(result.outbound)] : [],
        events: [],
      };
    }

    case 'submit_password': {
      const result = await submitAuthPassword(state, event.password);
      return {
        snapshot: createSessionSnapshotFromLegacy(result.nextState),
        commands: result.outbound ? [toSessionCommandOutbound(result.outbound)] : [],
        events: [],
      };
    }

    case 'refresh_qr': {
      const result = await refreshQrLogin(state);
      return {
        snapshot: createSessionSnapshotFromLegacy(result.nextState),
        commands: result.outbound ? [toSessionCommandOutbound(result.outbound)] : [],
        events: [],
      };
    }

    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}

export async function transitionSession(
  snapshot: SessionSnapshot,
  event: SessionHostEvent,
): Promise<SessionTransitionResult> {
  return runSessionMachine(snapshot, event, applySessionHostEvent);
}

export async function invokeSessionMethod<M extends ApiMethodPath>(
  snapshot: SessionSnapshot,
  method: M,
  params: ApiMethodParams<M>,
  opts?: { contentRelated?: boolean },
): Promise<SessionTransitionResult> {
  const result = await sendApiMethod(
    toLegacySessionState(snapshot),
    method,
    params,
    opts,
  );
  return toTransitionResult(
    result.nextState,
    result.outbound ? [result.outbound] : [],
    [],
  );
}
