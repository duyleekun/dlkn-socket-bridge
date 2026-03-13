/**
 * auth-extras.ts — auth.SignUp helper not covered by gramjs-statemachine.
 *
 * auth.SignUp is needed when the test DC requires account registration.
 * All other auth operations are provided by the gramjs-statemachine library.
 */

import { invokeSessionMethod } from "gramjs-statemachine";
import type { SessionSnapshot, SessionTransitionResult } from "gramjs-statemachine";

/**
 * Build an auth.SignUp request.
 *
 * Only needed for test-DC sessions where auth.signIn returns
 * auth.AuthorizationSignUpRequired (phone number not yet registered).
 */
export async function buildSignUp(
  state: SessionSnapshot,
  firstName: string,
  lastName: string,
): Promise<SessionTransitionResult> {
  return invokeSessionMethod(
    state,
    "auth.SignUp",
    {
      phoneNumber: state.context.phone!,
      phoneCodeHash: state.context.phoneCodeHash!,
      firstName,
      lastName,
    },
  );
}
