/**
 * gramjs-statemachine — main entry point
 *
 * Public API:
 *   step(state, inbound)          — process one inbound frame
 *   startDhExchange(state)        — kick off DH key exchange (no inbound)
 *   sendApiRequest(state, req)    — encrypt + frame any API request
 *   sendCode / signIn / ...       — login helpers
 *   createInitialState(opts)      — factory for fresh state
 */

import { startDhExchange } from './dh/dh-step1-req-pq.js';
export { step } from './step.js';

// ── Re-exports ────────────────────────────────────────────────────────────────

export type { SerializedState } from './types/state.js';
export type { StepResult } from './types/step-result.js';
export type { SessionEvent } from './types/session-event.js';
export type { TransportDirective } from './types/transport-directive.js';
export type { BeginAuthSessionResult, AdvanceSessionResult } from './types/session-result.js';
export { createInitialState } from './types/state.js';

export { startDhExchange } from './dh/dh-step1-req-pq.js';
export { Api } from 'telegram/tl/index.js';
export type { ApiMethodParams, ApiMethodPath } from './api/invoke.js';
export { sendApiMethod, sendApiRequest, randomLong } from './api/invoke.js';
export {
  sendCode,
  signIn,
  checkPassword,
  exportQrToken,
  importLoginToken,
  sendMsgsAck,
  sendGetPassword,
} from './auth/login-steps.js';
export { resolveTelegramDc, getDefaultTelegramDc, parseMigrateDc } from './dc/dc-resolver.js';
export { normalizeTlValue } from './dispatch/inbound-dispatch.js';
export {
  advanceSession,
  beginAuthSession,
  refreshQrLogin,
  submitAuthCode,
  submitAuthPassword,
} from './session/session-runtime.js';
