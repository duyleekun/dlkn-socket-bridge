import {
  createSession,
  transitionSession,
} from './session-runtime.js';
import {
  createSessionRuntimeAdapter,
  type SessionRuntimeAdapter as SharedSessionRuntimeAdapter,
} from 'shared-statemachine';
import {
  selectSessionView,
  type SessionView,
} from './session-view.js';
import type {
  CreateSessionInput,
  SessionHostEvent,
  SessionSnapshot,
  SessionStateValue,
} from './session-snapshot.js';
import type {
  SessionCommand,
} from '../types/session-command.js';
import type {
  SessionEvent,
} from '../types/session-event.js';
import type {
  SessionTransitionResult,
} from '../types/session-result.js';

export type SessionRuntimeAdapter = SharedSessionRuntimeAdapter<
  CreateSessionInput,
  SessionHostEvent,
  SessionSnapshot,
  SessionStateValue,
  SessionCommand,
  SessionEvent,
  SessionView
>;

export const sessionRuntimeAdapter = createSessionRuntimeAdapter<
  CreateSessionInput,
  SessionHostEvent,
  SessionSnapshot,
  SessionStateValue,
  SessionCommand,
  SessionEvent,
  SessionView
>({
  createSession,
  transitionSession,
  selectView: selectSessionView,
  getStateValue: (snapshot) => snapshot.value,
  buildInboundFrameEvent: (frame) => ({
    type: 'inbound_frame',
    frame,
  }),
  buildSocketClosedEvent: () => null,
});

export type {
  SessionCommand,
  SessionEvent,
  SessionTransitionResult,
};
