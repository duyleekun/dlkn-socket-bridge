import type { SessionSnapshot } from '../session/session-snapshot.js';
import type { SessionEvent } from './session-event.js';
import type { SessionCommand } from './session-command.js';
import type { SessionView } from '../session/session-view.js';

export interface SessionTransitionResult {
  snapshot: SessionSnapshot;
  commands: SessionCommand[];
  events: SessionEvent[];
  view: SessionView;
}
