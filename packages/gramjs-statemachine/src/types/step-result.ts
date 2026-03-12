import type { SerializedState } from './state.js';
import type { InternalAction } from './internal-action.js';

/**
 * The result of a single state machine step.
 *
 * - `nextState`: Always returned. **Persist this** before doing anything else.
 * - `outbound`: If present, send these bridge-ready bytes as-is.
 * - `actions`: Internal reducer outputs consumed by the session runtime.
 */
export interface StepResult {
  /** Updated state — always persist this. */
  nextState: SerializedState;
  /** Bytes to send via the bridge without additional transport framing. */
  outbound?: Uint8Array;
  /** Internal reducer outputs for the next runtime layer. */
  actions: InternalAction[];
}
