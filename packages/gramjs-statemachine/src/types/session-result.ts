import type { SessionSnapshot } from '../session/session-snapshot.js';
import type { SessionEvent } from './session-event.js';
import type { SessionCommand } from './session-command.js';
import type { SessionView } from '../session/session-view.js';
import type { SessionTransitionResult as SharedSessionTransitionResult } from 'shared-statemachine';

export type SessionTransitionResult = SharedSessionTransitionResult<
  SessionSnapshot,
  SessionCommand,
  SessionEvent,
  SessionView
>;
