import type { ZaloSessionCommand } from './session-command.js';
import type { ZaloSessionEvent } from './session-event.js';
import type { SessionSnapshot } from '../session/session-snapshot.js';
export interface ZaloSessionTransitionResult {
    snapshot: SessionSnapshot;
    commands: ZaloSessionCommand[];
    events: ZaloSessionEvent[];
}
//# sourceMappingURL=session-result.d.ts.map