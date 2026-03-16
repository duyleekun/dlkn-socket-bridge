import { parseSocketFrame } from '../framing/socket.js';
import { createSessionTransitionResult } from 'shared-statemachine';
import { createInitialState } from '../types/state.js';
import type { ZaloSerializedState } from '../types/state.js';
import type { SessionCommand } from '../types/session-command.js';
import type { SessionEvent } from '../types/session-event.js';
import type { SessionTransitionResult } from '../types/session-result.js';
import { buildZaloWsHeaders } from '../ws-url/ws-url.js';
import {
  createSnapshotFromState,
  type SessionSnapshot,
  type ZaloSessionHostEvent,
  type ZaloStateMachineValue,
  type CreateSessionInput,
} from './session-snapshot.js';
import { selectSessionView } from './session-view.js';
import { runSessionMachine } from './session-machine.js';

function makeResult(
  value: ZaloStateMachineValue,
  context: ZaloSerializedState,
  commands: SessionCommand[],
  events: SessionEvent[],
): SessionTransitionResult {
  const snapshot = createSnapshotFromState(value, context);
  return createSessionTransitionResult(
    snapshot,
    commands,
    events,
    selectSessionView(snapshot),
  );
}

function isRemoteLogoutClose(code: number, reason: string): boolean {
  return code === 1000 && reason.trim().toLowerCase() === 'error';
}

export async function createSession(input: CreateSessionInput): Promise<SessionTransitionResult> {
  const state = createInitialState({
    userAgent: input.userAgent,
    language: input.language,
    credentials: input.credentials,
  });

  if (input.mode === 'qr') {
    const nextState: ZaloSerializedState = { ...state, phase: 'qr_connecting' };
    return makeResult('qr_connecting', nextState, [{ type: 'http_login_qr' }], []);
  }

  // credentials mode
  if (!input.credentials) {
    throw new Error('credentials required for mode=credentials');
  }
  const nextState: ZaloSerializedState = { ...state, phase: 'cred_logging_in', credentials: input.credentials };
  return makeResult('cred_logging_in', nextState, [
    { type: 'http_login_creds', credentials: input.credentials },
  ], []);
}

async function applyHostEvent(
  snapshot: SessionSnapshot,
  event: ZaloSessionHostEvent,
): Promise<{ snapshot: SessionSnapshot; commands: SessionCommand[]; events: SessionEvent[] }> {
  const ctx = snapshot.context;

  switch (event.type) {
    case 'inbound_frame': {
      const parsedEvents = await parseSocketFrame(event.frame, {
        cipherKey: ctx.cipherKey ?? undefined,
      });
      let nextValue = snapshot.value;
      let nextContext = ctx;
      const commands: SessionCommand[] = [];
      const events: SessionEvent[] = [];
      let shouldSendPing = false;

      for (const parsedEvent of parsedEvents) {
        if (parsedEvent.type === 'cipher_key') {
          nextContext = { ...nextContext, cipherKey: parsedEvent.key };
          if (snapshot.value === 'ws_connecting' || snapshot.value === 'reconnecting') {
            shouldSendPing = true;
          }
          continue;
        }

        if (parsedEvent.type === 'duplicate_connection') {
          nextValue = 'error';
          nextContext = {
            ...nextContext,
            phase: 'error',
            errorMessage: 'Duplicate Zalo connection detected.',
          };
          continue;
        }

        events.push(parsedEvent);
      }

      if (shouldSendPing && nextValue !== 'error') {
        nextValue = 'listening';
        commands.push({ type: 'send_ping' });
      }

      if (nextValue !== snapshot.value) {
        nextContext = {
          ...nextContext,
          phase: nextValue as ZaloSerializedState['phase'],
        };
      }

      return {
        snapshot: createSnapshotFromState(nextValue, nextContext),
        commands,
        events,
      };
    }

    case 'ws_closed': {
      const isListening = snapshot.value === 'listening';
      const remoteLogout = isListening && isRemoteLogoutClose(event.code, event.reason);
      const nextValue: ZaloStateMachineValue =
        remoteLogout ? 'error' : isListening ? 'reconnecting' : 'error';
      const nextCtx: ZaloSerializedState = {
        ...ctx,
        phase: nextValue as ZaloSerializedState['phase'],
        credentials: remoteLogout ? null : ctx.credentials,
        wsUrl: remoteLogout ? null : ctx.wsUrl,
        cipherKey: null,
        errorMessage: remoteLogout
          ? 'Zalo session ended remotely. Scan a new QR code to sign back in.'
          : isListening
            ? null
            : `WebSocket closed: ${event.reason} (${event.code})`,
        reconnectCount: isListening ? ctx.reconnectCount + 1 : ctx.reconnectCount,
      };
      const commands: SessionCommand[] = [];
      if (remoteLogout) {
        commands.push({ type: 'clear_credentials' });
      } else if (isListening && ctx.wsUrl && ctx.credentials) {
        commands.push({
          type: 'reconnect',
          wsUrl: ctx.wsUrl,
          headers: buildZaloWsHeaders(ctx.credentials, ctx.wsUrl),
        });
        commands.push({ type: 'send_ping' });
      }
      return {
        snapshot: createSnapshotFromState(nextValue, nextCtx),
        commands,
        events: [],
      };
    }

    case 'http_login_qr_result': {
      const { qrData } = event;
      const nextCtx: ZaloSerializedState = {
        ...ctx,
        qrData,
        phase: 'qr_awaiting_scan',
      };
      return {
        snapshot: createSnapshotFromState('qr_awaiting_scan', nextCtx),
        commands: [],
        events: [{ type: 'qr_ready', qrImage: qrData.image, qrToken: qrData.token, expiresAt: qrData.expiresAt }],
      };
    }

    case 'qr_scan_event': {
      if (event.event === 'scanned') {
        const scanData = event.data as { avatar?: string; displayName?: string } | undefined;
        return {
          snapshot: createSnapshotFromState('qr_scanned', { ...ctx, phase: 'qr_scanned' }),
          commands: [],
          events: [{ type: 'qr_scanned', scanInfo: { avatar: scanData?.avatar, displayName: scanData?.displayName } }],
        };
      }
      if (event.event === 'confirmed') {
        // confirmed comes via http_login_creds_result
        return { snapshot, commands: [], events: [] };
      }
      if (event.event === 'expired' || event.event === 'declined') {
        return {
          snapshot: createSnapshotFromState('idle', { ...ctx, phase: 'idle', qrData: null }),
          commands: [],
          events: [],
        };
      }
      return { snapshot, commands: [], events: [] };
    }

    case 'http_login_creds_result': {
      const { credentials, userProfile, wsUrl, pingIntervalMs } = event;
      const nextCtx: ZaloSerializedState = {
        ...ctx,
        phase: 'ws_connecting',
        credentials,
        userProfile,
        wsUrl,
        pingIntervalMs,
        qrData: null,
        errorMessage: null,
      };
      return {
        snapshot: createSnapshotFromState('ws_connecting', nextCtx),
        commands: [
          { type: 'persist_credentials', credentials, userProfile, wsUrl, pingIntervalMs },
          {
            type: 'reconnect',
            wsUrl,
            headers: buildZaloWsHeaders(credentials, wsUrl),
          },
          { type: 'send_ping' },
        ],
        events: [{ type: 'login_success', credentials, userProfile }],
      };
    }

    case 'http_login_failed': {
      const nextCtx: ZaloSerializedState = {
        ...ctx,
        phase: 'error',
        errorMessage: event.errorMessage,
      };
      return {
        snapshot: createSnapshotFromState('error', nextCtx),
        commands: [],
        events: [],
      };
    }

    case 'logout': {
      const nextCtx: ZaloSerializedState = {
        ...ctx,
        phase: 'idle',
        credentials: null,
        userProfile: null,
        cipherKey: null,
        wsUrl: null,
        qrData: null,
        errorMessage: null,
      };
      return {
        snapshot: createSnapshotFromState('idle', nextCtx),
        commands: [{ type: 'clear_credentials' }],
        events: [],
      };
    }

    default: {
      const _exhaustive: never = event;
      void _exhaustive;
      return { snapshot, commands: [], events: [] };
    }
  }
}

export async function transitionSession(
  snapshot: SessionSnapshot,
  event: ZaloSessionHostEvent,
): Promise<SessionTransitionResult> {
  return runSessionMachine(snapshot, event, applyHostEvent);
}
