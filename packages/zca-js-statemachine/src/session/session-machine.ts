import * as robot3 from 'robot3';
import { createSessionTransitionResult, withRuntimeView } from 'shared-statemachine';
import type { SessionEvent } from '../types/session-event.js';
import type { SessionCommand } from '../types/session-command.js';
import type { SessionTransitionResult } from '../types/session-result.js';
import type { ZaloSessionHostEvent, SessionSnapshot, ZaloStateMachineValue } from './session-snapshot.js';
import { selectSessionView } from './session-view.js';
const robot3Api = robot3;

interface TransitionPayload {
  snapshot: SessionSnapshot;
  commands: SessionCommand[];
  events: SessionEvent[];
}

function emptyResult(snapshot: SessionSnapshot): SessionTransitionResult {
  return createSessionTransitionResult(
    snapshot,
    [],
    [],
    selectSessionView(snapshot),
  );
}

function createTransitionMachine(initial: ZaloStateMachineValue) {
  return robot3Api.createMachine(initial, {
    idle: robot3Api.state(
      robot3Api.transition('logout', 'idle') as never,
    ),
    qr_connecting: robot3Api.state(
      robot3Api.transition('ws_closed', 'qr_connecting') as never,
      robot3Api.transition('http_login_qr_result', 'qr_connecting') as never,
      robot3Api.transition('http_login_creds_result', 'qr_connecting') as never,
      robot3Api.transition('http_login_failed', 'qr_connecting') as never,
    ),
    qr_awaiting_scan: robot3Api.state(
      robot3Api.transition('qr_scan_event', 'qr_awaiting_scan') as never,
      robot3Api.transition('inbound_frame', 'qr_awaiting_scan') as never,
      robot3Api.transition('ws_closed', 'qr_awaiting_scan') as never,
      robot3Api.transition('http_login_creds_result', 'qr_awaiting_scan') as never,
      robot3Api.transition('http_login_failed', 'qr_awaiting_scan') as never,
    ),
    qr_scanned: robot3Api.state(
      robot3Api.transition('qr_scan_event', 'qr_scanned') as never,
      robot3Api.transition('http_login_creds_result', 'qr_scanned') as never,
      robot3Api.transition('http_login_failed', 'qr_scanned') as never,
    ),
    qr_expired: robot3Api.state(),
    cred_logging_in: robot3Api.state(
      robot3Api.transition('http_login_creds_result', 'cred_logging_in') as never,
      robot3Api.transition('http_login_failed', 'cred_logging_in') as never,
    ),
    logged_in: robot3Api.state(),
    ws_connecting: robot3Api.state(
      robot3Api.transition('ws_closed', 'ws_connecting') as never,
      robot3Api.transition('inbound_frame', 'ws_connecting') as never,
    ),
    listening: robot3Api.state(
      robot3Api.transition('inbound_frame', 'listening') as never,
      robot3Api.transition('ws_closed', 'listening') as never,
      robot3Api.transition('logout', 'listening') as never,
    ),
    reconnecting: robot3Api.state(
      robot3Api.transition('ws_closed', 'reconnecting') as never,
      robot3Api.transition('inbound_frame', 'reconnecting') as never,
    ),
    error: robot3Api.state(),
  });
}

function canHandleEvent(snapshot: SessionSnapshot, event: ZaloSessionHostEvent): boolean {
  const machine = createTransitionMachine(snapshot.value);
  const stateObj = machine.states[snapshot.value];
  if (!stateObj) return false;
  return (stateObj.transitions as Map<string, unknown[]>).has(event.type);
}

export async function runSessionMachine(
  snapshot: SessionSnapshot,
  event: ZaloSessionHostEvent,
  handler: (snapshot: SessionSnapshot, event: ZaloSessionHostEvent) => Promise<TransitionPayload>,
): Promise<SessionTransitionResult> {
  if (!canHandleEvent(snapshot, event)) {
    return emptyResult(snapshot);
  }
  const payload = await handler(snapshot, event);
  return withRuntimeView({
    snapshot: payload.snapshot,
    commands: payload.commands,
    events: payload.events,
  }, selectSessionView);
}
