/**
 * Login step functions: each takes state + params, returns StepResult.
 *
 * Supports phone-code login, 2FA password, and QR token login flows.
 */

import { Api } from 'telegram/tl/index.js';
import bigInt from 'big-integer';
import { computeCheck } from 'telegram/Password.js';
import type { SerializedState } from '../types/state.js';
import type { StepResult } from '../types/step-result.js';
import { sendApiRequest } from '../api/invoke.js';
import { fromHex } from '../session/crypto.js';

/**
 * Send auth.SendCode — initiates phone-code login.
 * state.phone must be set.
 */
export async function sendCode(state: SerializedState): Promise<StepResult> {
  if (!state.phone) throw new Error('state.phone is required for sendCode');

  const req = new Api.auth.SendCode({
    phoneNumber: state.phone,
    apiId: parseInt(state.apiId, 10),
    apiHash: state.apiHash,
    settings: new Api.CodeSettings({}),
  });
  return sendApiRequest({ ...state, phase: 'CODE_SENT' }, req);
}

/**
 * Send auth.SignIn — submit the phone code.
 */
export async function signIn(
  state: SerializedState,
  opts: { code: string },
): Promise<StepResult> {
  if (!state.phone) throw new Error('state.phone is required for signIn');
  if (!state.phoneCodeHash) throw new Error('state.phoneCodeHash is required for signIn');

  const req = new Api.auth.SignIn({
    phoneNumber: state.phone,
    phoneCodeHash: state.phoneCodeHash,
    phoneCode: opts.code,
  });
  return sendApiRequest({ ...state, phase: 'SIGN_IN_SENT' }, req);
}

/**
 * Send auth.CheckPassword — submit the 2FA password.
 * Reconstructs the SRP check from state.passwordSrp.
 */
export async function checkPassword(
  state: SerializedState,
  opts: { password: string },
): Promise<StepResult> {
  if (!state.passwordSrp) throw new Error('missing SRP data in state');

  const passwordObj = {
    currentAlgo: new Api.PasswordKdfAlgoSHA256SHA256PBKDF2HMACSHA512iter100000SHA256ModPow({
      g: state.passwordSrp.g,
      p: Buffer.from(fromHex(state.passwordSrp.pHex)),
      salt1: Buffer.from(fromHex(state.passwordSrp.salt1Hex)),
      salt2: Buffer.from(fromHex(state.passwordSrp.salt2Hex)),
    }),
    srp_B: Buffer.from(fromHex(state.passwordSrp.srpBHex)),
    srpB: Buffer.from(fromHex(state.passwordSrp.srpBHex)),
    srpId: BigInt(state.passwordSrp.srpId),
  } as unknown as InstanceType<typeof Api.account.Password>;

  const check = await computeCheck(passwordObj, opts.password);
  const req = new Api.auth.CheckPassword({ password: check });
  return sendApiRequest({ ...state, phase: 'CHECK_PASSWORD_SENT' }, req);
}

/**
 * Send auth.ExportLoginToken — request a QR login token.
 */
export async function exportQrToken(state: SerializedState): Promise<StepResult> {
  const req = new Api.auth.ExportLoginToken({
    apiId: parseInt(state.apiId, 10),
    apiHash: state.apiHash,
    exceptIds: [],
  });
  return sendApiRequest({ ...state, phase: 'QR_TOKEN_SENT' }, req);
}

/**
 * Send auth.ImportLoginToken — import a scanned QR token.
 */
export async function importLoginToken(
  state: SerializedState,
  opts: { tokenBase64Url: string },
): Promise<StepResult> {
  const req = new Api.auth.ImportLoginToken({
    token: Buffer.from(opts.tokenBase64Url, 'base64url'),
  });
  return sendApiRequest({ ...state, phase: 'QR_IMPORT_SENT' }, req);
}

/**
 * Send MsgsAck — acknowledge received message IDs (not content-related).
 */
export async function sendMsgsAck(
  state: SerializedState,
  msgIds: bigint[],
): Promise<StepResult> {
  const req = new Api.MsgsAck({ msgIds: msgIds.map((id) => bigInt(id.toString())) });
  return sendApiRequest(state, req, { contentRelated: false });
}

/**
 * Send account.GetPassword — fetch 2FA password info from server.
 */
export async function sendGetPassword(state: SerializedState): Promise<StepResult> {
  return sendApiRequest(
    { ...state, phase: 'PASSWORD_INFO_SENT' },
    new Api.account.GetPassword(),
  );
}
