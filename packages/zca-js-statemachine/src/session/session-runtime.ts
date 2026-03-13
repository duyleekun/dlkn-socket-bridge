import { createInitialState } from '../types/state.js';
import type { ZaloSerializedState } from '../types/state.js';
import type { ZaloSessionCommand } from '../types/session-command.js';
import type { ZaloSessionEvent } from '../types/session-event.js';
import type { ZaloSessionTransitionResult } from '../types/session-result.js';
import { dispatchInboundFrame } from '../dispatch/inbound-dispatch.js';
import { buildPingFrame } from '../framing/zalo-frame-codec.js';
import { buildZaloWsHeaders } from '../ws-url/ws-url.js';
import {
  createSnapshotFromState,
  type SessionSnapshot,
  type ZaloSessionHostEvent,
  type ZaloStateMachineValue,
  type CreateSessionInput,
} from './session-snapshot.js';
import { runSessionMachine } from './session-machine.js';

function makeResult(
  value: ZaloStateMachineValue,
  context: ZaloSerializedState,
  commands: ZaloSessionCommand[],
  events: ZaloSessionEvent[],
): ZaloSessionTransitionResult {
  return {
    snapshot: createSnapshotFromState(value, context),
    commands,
    events,
  };
}

function isRemoteLogoutClose(code: number, reason: string): boolean {
  return code === 1000 && reason.trim().toLowerCase() === 'error';
}

export async function createSession(input: CreateSessionInput): Promise<ZaloSessionTransitionResult> {
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
): Promise<{ snapshot: SessionSnapshot; commands: ZaloSessionCommand[]; events: ZaloSessionEvent[] }> {
  const ctx = snapshot.context;

  switch (event.type) {
    case 'inbound_frame': {
      const result = await dispatchInboundFrame(ctx, event.frame);
      // If we received cipher key (state stays the same value but context updated)
      // If we were ws_connecting and received cipher key → transition to listening
      let nextValue = snapshot.value;
      const commands = [...result.commands];
      if (result.nextContext.cipherKey && !ctx.cipherKey) {
        if (snapshot.value === 'ws_connecting' || snapshot.value === 'reconnecting') {
          nextValue = 'listening';
          commands.push({ type: 'send_ping' });
        }
      }
      return {
        snapshot: createSnapshotFromState(nextValue, result.nextContext),
        commands,
        events: result.events,
      };
    }

    case 'ws_connected': {
      // Transition from qr_connecting → qr_awaiting_scan (waiting for cipher key + QR)
      // or from ws_connecting/reconnecting → ws_connecting (waiting for cipher key)
      let nextValue: ZaloStateMachineValue = snapshot.value;
      if (snapshot.value === 'qr_connecting') {
        nextValue = 'qr_awaiting_scan';
      } else if (snapshot.value === 'ws_connecting' || snapshot.value === 'reconnecting') {
        nextValue = 'ws_connecting'; // stays, waiting for cipher key frame
      }
      const nextCtx: ZaloSerializedState = {
        ...ctx,
        phase: nextValue as ZaloSerializedState['phase'],
        lastConnectedAt: Date.now(),
        cipherKey: null, // reset cipher key on new connection
      };
      return {
        snapshot: createSnapshotFromState(nextValue, nextCtx),
        commands: [{ type: 'send_ping' }],
        events: [],
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
      const commands: ZaloSessionCommand[] = [];
      if (remoteLogout) {
        commands.push({ type: 'clear_credentials' });
      } else if (isListening && ctx.wsUrl && ctx.credentials) {
        commands.push({
          type: 'reconnect',
          wsUrl: ctx.wsUrl,
          headers: buildZaloWsHeaders(ctx.credentials, ctx.wsUrl),
          firstFrame: buildPingFrame(),
        });
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
            firstFrame: buildPingFrame(),
          },
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
): Promise<ZaloSessionTransitionResult> {
  return runSessionMachine(snapshot, event, applyHostEvent);
}
