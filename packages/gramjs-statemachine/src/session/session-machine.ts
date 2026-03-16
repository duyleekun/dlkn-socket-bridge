import * as robot3 from 'robot3';
import { createSessionTransitionResult, withRuntimeView } from 'shared-statemachine';
import type { SessionEvent } from '../types/session-event.js';
import type { SessionCommand } from '../types/session-command.js';
import type { SessionTransitionResult } from '../types/session-result.js';
import type {
  SessionHostEvent,
  SessionSnapshot,
  SessionStateValue,
} from './session-snapshot.js';
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

function createTransitionMachine(initial: SessionStateValue) {
  return robot3Api.createMachine(initial, {
    handshake: robot3Api.state(
      robot3Api.transition('inbound_frame', 'handshake') as never,
    ),
    authorizing: robot3Api.state(
      robot3Api.transition('inbound_frame', 'authorizing') as never,
    ),
    awaiting_code: robot3Api.state(
      robot3Api.transition('inbound_frame', 'awaiting_code') as never,
      robot3Api.transition('submit_code', 'awaiting_code') as never,
    ),
    awaiting_password: robot3Api.state(
      robot3Api.transition('inbound_frame', 'awaiting_password') as never,
      robot3Api.transition('submit_password', 'awaiting_password') as never,
    ),
    awaiting_qr_scan: robot3Api.state(
      robot3Api.transition('inbound_frame', 'awaiting_qr_scan') as never,
      robot3Api.transition('refresh_qr', 'awaiting_qr_scan') as never,
    ),
    ready: robot3Api.state(
      robot3Api.transition('inbound_frame', 'ready') as never,
    ),
    error: robot3Api.state(),
  });
}

function canHandleEvent(
  snapshot: SessionSnapshot,
  event: SessionHostEvent,
): boolean {
  const machine = createTransitionMachine(snapshot.value);
  return (
    machine.states[snapshot.value].transitions as Map<string, unknown[]>
  ).has(event.type);
}

export async function runSessionMachine(
  snapshot: SessionSnapshot,
  event: SessionHostEvent,
  handler: (snapshot: SessionSnapshot, event: SessionHostEvent) => Promise<TransitionPayload>,
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
