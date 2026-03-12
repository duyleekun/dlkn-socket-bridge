/**
 * auth-extras.ts — auth.SignUp helper not covered by gramjs-statemachine.
 *
 * auth.SignUp is needed when the test DC requires account registration.
 * All other auth operations are provided by the gramjs-statemachine library.
 */

import { sendApiMethod } from "gramjs-statemachine";
import type { SerializedState, StepResult } from "gramjs-statemachine";

/**
 * Build an auth.SignUp request.
 *
 * Only needed for test-DC sessions where auth.signIn returns
 * auth.AuthorizationSignUpRequired (phone number not yet registered).
 */
export async function buildSignUp(
  state: SerializedState,
  firstName: string,
  lastName: string,
): Promise<StepResult> {
  return sendApiMethod(
    state,
    "auth.SignUp",
    {
      phoneNumber: state.phone!,
      phoneCodeHash: state.phoneCodeHash!,
      firstName,
      lastName,
    },
  );
}
