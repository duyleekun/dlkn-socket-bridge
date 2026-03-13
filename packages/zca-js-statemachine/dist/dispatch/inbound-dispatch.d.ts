import type { ZaloSerializedState } from '../types/state.js';
import type { ZaloSessionCommand } from '../types/session-command.js';
import type { ZaloSessionEvent } from '../types/session-event.js';
export interface DispatchResult {
    commands: ZaloSessionCommand[];
    events: ZaloSessionEvent[];
    nextContext: ZaloSerializedState;
}
export declare function dispatchInboundFrame(context: ZaloSerializedState, frame: Uint8Array): Promise<DispatchResult>;
//# sourceMappingURL=inbound-dispatch.d.ts.map