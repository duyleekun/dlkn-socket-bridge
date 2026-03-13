import type { ZaloSessionTransitionResult } from '../types/session-result.js';
import { type SessionSnapshot, type ZaloSessionHostEvent, type CreateSessionInput } from './session-snapshot.js';
export declare function createSession(input: CreateSessionInput): Promise<ZaloSessionTransitionResult>;
export declare function transitionSession(snapshot: SessionSnapshot, event: ZaloSessionHostEvent): Promise<ZaloSessionTransitionResult>;
//# sourceMappingURL=session-runtime.d.ts.map