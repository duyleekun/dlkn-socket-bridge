import type { SerializedState } from './state.js';
import type { Action } from './action.js';

/**
 * The result of a single state machine step.
 *
 * - `nextState`: Always returned. **Persist this** before doing anything else.
 * - `outbound`: If present, send these bridge-ready bytes as-is.
 * - `actions`: Side effects to process (UI updates, re-sends, etc.).
 */
export interface StepResult {
  /** Updated state — always persist this. */
  nextState: SerializedState;
  /** Bytes to send via the bridge without additional transport framing. */
  outbound?: Uint8Array;
  /** Side effects to handle. */
  actions: Action[];
}
