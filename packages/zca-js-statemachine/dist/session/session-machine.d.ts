import type { ZaloSessionEvent } from '../types/session-event.js';
import type { ZaloSessionCommand } from '../types/session-command.js';
import type { ZaloSessionTransitionResult } from '../types/session-result.js';
import type { ZaloSessionHostEvent, SessionSnapshot } from './session-snapshot.js';
interface TransitionPayload {
    snapshot: SessionSnapshot;
    commands: ZaloSessionCommand[];
    events: ZaloSessionEvent[];
}
export declare function runSessionMachine(snapshot: SessionSnapshot, event: ZaloSessionHostEvent, handler: (snapshot: SessionSnapshot, event: ZaloSessionHostEvent) => Promise<TransitionPayload>): Promise<ZaloSessionTransitionResult>;
export {};
//# sourceMappingURL=session-machine.d.ts.map