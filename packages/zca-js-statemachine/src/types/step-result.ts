import type { ZaloSerializedState } from './state.js';
import type { ZaloSessionCommand } from './session-command.js';
import type { ZaloSessionEvent } from './session-event.js';

export interface StepResult {
  nextState: ZaloSerializedState;
  commands?: ZaloSessionCommand[];
  events?: ZaloSessionEvent[];
}
