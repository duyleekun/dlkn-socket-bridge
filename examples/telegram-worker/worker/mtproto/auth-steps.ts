/**
 * DH key exchange step functions for MTProto authentication.
 *
 * These functions are called from the state machine in sequence:
 *   1. buildReqPqMulti()     — initial request
 *   2. handleResPQ()         — factorize pq, RSA encrypt, build req_DH_params
 *   3. handleServerDHParams() — AES-IGE decrypt, compute g_b, build set_client_DH_params
 *   4. handleDHGenResult()   — verify auth_key, compute salt
 *
 * Each returns bytes to send and state updates to persist.
 */

import bigInt from "big-integer";
import { AuthKey as GramJsAuthKey } from "telegram/crypto/AuthKey";
import { LAYER as GRAMJS_LAYER } from "telegram/tl/AllTLObjects";
import { computeCheck } from "telegram/Password.js";
import {
  sha1,
  generateNonce,
  aesIgeEncrypt,
  aesIgeDecrypt,
  rsaEncryptMtproto2,
  factorizePQ,
  computeDHKey,
  computeGB,
  concatBytes,
  bigIntFromBytes,
  bigIntToBytesLE,
  bigIntToBytes,
  tlBigIntFromBytesBE,
  tlBigIntFromBytesLE,
  tlBigIntToBytesLE,
  fingerprintToHex,
  KNOWN_RSA_FINGERPRINTS,
  toHex,
  fromHex,
} from "./crypto";
import { serializeTLObject, createReader, Api } from "./serializer";
import { wrapPlainMessage, unwrapPlainMessage } from "./plain-message";
import { encryptMessage } from "./encrypted-message";
import type { PasswordSrpState, SessionState } from "../types";

interface StepResult {
  sendBytes: Uint8Array;
  stateUpdates: Partial<SessionState>;
}

/** Convert Uint8Array to BigInteger (for gramjs int128/int256/long fields). */
function bytesToBigInt(bytes: Uint8Array): ReturnType<typeof bigInt> {
  return tlBigIntFromBytesBE(bytes);
}

function wrapInInitConnection(
  apiId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query: any,
): InstanceType<typeof Api.InvokeWithLayer> {
  return new Api.InvokeWithLayer({
    layer: GRAMJS_LAYER,
    query: new Api.InitConnection({
      apiId: parseInt(apiId, 10),
      deviceModel: "dlkn-socket-bridge",
      systemVersion: "1.0",
      appVersion: "1.0",
      systemLangCode: "en",
      langCode: "en",
      langPack: "",
      query,
    }),
  });
}

function buildEncryptedRequest(
  state: SessionState,
  apiId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query: any,
  nextState: SessionState["state"],
): { sendBytes: Uint8Array; stateUpdates: Partial<SessionState> } {
  const request = state.connectionInited
    ? query
    : wrapInInitConnection(apiId, query);
  const body = serializeTLObject(request);
  const seqNo = state.seqNo * 2 + 1;
  const { encrypted, msgId } = encryptMessage(
    state.authKey!,
    state.serverSalt!,
    state.sessionId!,
    seqNo,
    body,
    state.timeOffset,
    state.lastMsgId ? BigInt(state.lastMsgId) : undefined,
  );

  return {
    sendBytes: encrypted,
    stateUpdates: {
      state: nextState,
      connectionInited: true,
      seqNo: state.seqNo + 1,
      lastMsgId: msgId.toString(),
    },
  };
}

// ─── Step 1: Build req_pq_multi ───

export function buildReqPqMulti(): StepResult {
  const nonce = generateNonce(16);

  // req_pq_multi#be7e8ef1 nonce:int128 = ResPQ
  // nonce field is BigInteger (int128)
  const reqPq = new Api.ReqPqMulti({
    nonce: bytesToBigInt(nonce),
  });
  const body = serializeTLObject(reqPq);
  const { message, msgId } = wrapPlainMessage(body);

  return {
    sendBytes: message,
    stateUpdates: {
      lastMsgId: msgId.toString(),
      nonce: toHex(nonce),
    },
  };
}

// ─── Step 2: Handle ResPQ → build req_DH_params ───

export function handleResPQ(
  state: SessionState,
  payload: Uint8Array,
): StepResult {
  const { body } = unwrapPlainMessage(payload);
  const reader = createReader(body);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const resPq = reader.tgReadObject() as any;

  // Extract server nonce.
  // gramjs serializes int128 as little-endian, so the BigInteger value is the
  // LE interpretation of the wire bytes. To recover the raw wire bytes (needed
  // for AES KDF in step 3), convert back to LE bytes.
  const serverNonce = tlBigIntToBytesLE(resPq.serverNonce, 16);

  // Extract pq (Buffer → Uint8Array)
  const pqBuf: Buffer = resPq.pq;
  const pqBytes = new Uint8Array(pqBuf);

  // Extract fingerprints (BigInteger[])
  const fingerprints: Array<ReturnType<typeof bigInt>> = resPq.serverPublicKeyFingerprints;

  // Factorize pq
  const pqInt = bigIntFromBytes(pqBytes);
  const { p, q } = factorizePQ(pqInt);
  const pBytes = bigIntToBytes(p, 4);
  const qBytes = bigIntToBytes(q, 4);

  let matchedFp: ReturnType<typeof bigInt> | undefined;
  let matchedFpHex = "";
  for (const fp of fingerprints) {
    const hex = fingerprintToHex(fp);
    if (KNOWN_RSA_FINGERPRINTS.includes(hex)) {
      matchedFp = fp;
      matchedFpHex = hex;
      break;
    }
  }

  if (!matchedFp) {
    const fpList = fingerprints.map((f) => fingerprintToHex(f)).join(", ");
    throw new Error(`no matching RSA fingerprint found among: ${fpList}`);
  }

  // nonce: our generated bytes stored as big-endian hex → recover raw bytes
  const nonce = fromHex(state.nonce!);
  const nonceBig = bytesToBigInt(nonce);

  // Generate new_nonce (32 raw random bytes).
  // Store them as-is (big-endian hex of the raw bytes). The AES KDF in step 3
  // will use fromHex(state.newNonce) which gives the same raw bytes.
  // For the PQInnerData int256 field, gramjs writes int256 as little-endian,
  // so we pass bigIntFromBytesLE(newNonceBytes) so that the LE wire bytes
  // reconstruct the original newNonceBytes on the server side.
  const newNonceBytes = generateNonce(32);
  const newNonceBig = tlBigIntFromBytesLE(newNonceBytes);

  // Build p_q_inner_data
  const innerData = new Api.PQInnerData({
    pq: Buffer.from(pqBytes),
    p: Buffer.from(pBytes),
    q: Buffer.from(qBytes),
    nonce: nonceBig,
    serverNonce: resPq.serverNonce,
    newNonce: newNonceBig,
  });

  const innerDataBytes = serializeTLObject(innerData);

  // MTProto 2.0 RSA — pass raw innerDataBytes (no SHA1, no manual padding)
  const encryptedData = rsaEncryptMtproto2(innerDataBytes, matchedFpHex);

  // Build req_DH_params
  const reqDH = new Api.ReqDHParams({
    nonce: nonceBig,
    serverNonce: resPq.serverNonce,
    p: Buffer.from(pBytes),
    q: Buffer.from(qBytes),
    publicKeyFingerprint: matchedFp,
    encryptedData: Buffer.from(encryptedData),
  });

  const reqDHBody = serializeTLObject(reqDH);
  const previousMsgId = state.lastMsgId ? BigInt(state.lastMsgId) : undefined;
  const { message, msgId } = wrapPlainMessage(reqDHBody, 0, previousMsgId);

  return {
    sendBytes: message,
    stateUpdates: {
      state: "DH_SENT",
      lastMsgId: msgId.toString(),
      // Store raw wire bytes as hex so fromHex() in step 3 recovers them directly
      serverNonce: toHex(serverNonce),
      newNonce: toHex(newNonceBytes),
      pq: toHex(pqBytes),
      p: toHex(pBytes),
      q: toHex(qBytes),
      fingerprint: matchedFpHex,
    },
  };
}

// ─── Step 3: Handle server_DH_params → build set_client_DH_params ───

export function handleServerDHParams(
  state: SessionState,
  payload: Uint8Array,
): StepResult {
  const { body } = unwrapPlainMessage(payload);
  const reader = createReader(body);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dhParams = reader.tgReadObject() as any;

  // Check if it's server_DH_params_ok
  if (dhParams.className !== "ServerDHParamsOk") {
    throw new Error(`unexpected DH params response: ${dhParams.className}`);
  }

  const encryptedAnswer = new Uint8Array(dhParams.encryptedAnswer as Buffer);
  const nonce = fromHex(state.nonce!);
  const nonceBig = bytesToBigInt(nonce);
  const expectedServerNonce = tlBigIntFromBytesLE(fromHex(state.serverNonce!));

  if (dhParams.nonce.neq(nonceBig) || dhParams.serverNonce.neq(expectedServerNonce)) {
    throw new Error("server_DH_params nonce mismatch");
  }

  const newNonce = fromHex(state.newNonce!);
  const serverNonce = fromHex(state.serverNonce!);

  // Derive AES key + IV from new_nonce and server_nonce
  const hash1 = sha1(concatBytes(newNonce, serverNonce));
  const hash2 = sha1(concatBytes(serverNonce, newNonce));
  const hash3 = sha1(concatBytes(newNonce, newNonce));

  const tmpAesKey = concatBytes(hash1, hash2.slice(0, 12));
  const tmpAesIv = concatBytes(hash2.slice(12, 20), hash3, newNonce.slice(0, 4));

  // Decrypt server DH inner data
  const decrypted = aesIgeDecrypt(encryptedAnswer, tmpAesKey, tmpAesIv);

  // First 20 bytes = SHA1 hash, then the TL object
  const innerReader = createReader(decrypted.slice(20));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const innerData = innerReader.tgReadObject() as any;

  // Extract DH parameters
  const g: number = innerData.g;
  const dhPrimeBytes = new Uint8Array(innerData.dhPrime as Buffer);
  const gABytes = new Uint8Array(innerData.gA as Buffer);
  const serverTime: number = innerData.serverTime;

  // Calculate time offset
  const timeOffset = serverTime - Math.floor(Date.now() / 1000);

  // Generate b (256 bytes random)
  const b = generateNonce(256);

  // Compute g_b = g^b mod dh_prime
  const gB = computeGB(g, b, dhPrimeBytes);

  // Compute auth_key = g_a^b mod dh_prime
  const authKey = computeDHKey(gABytes, b, dhPrimeBytes);
  const authKeyHash = sha1(authKey);
  const authKeyId = authKeyHash.slice(12, 20); // lower 64 bits

  // Build client_DH_inner_data
  const clientInner = new Api.ClientDHInnerData({
    nonce: nonceBig,
    serverNonce: expectedServerNonce,
    retryId: bigInt.zero,
    gB: Buffer.from(gB),
  });

  const clientInnerBytes = serializeTLObject(clientInner);
  const clientInnerHash = sha1(clientInnerBytes);
  const dataWithHash = concatBytes(clientInnerHash, clientInnerBytes);

  // Pad to multiple of 16
  const padNeeded = (16 - (dataWithHash.length % 16)) % 16;
  const padded = padNeeded > 0
    ? concatBytes(dataWithHash, generateNonce(padNeeded))
    : dataWithHash;

  // Encrypt with same AES key/IV
  const encryptedData = aesIgeEncrypt(padded, tmpAesKey, tmpAesIv);

  // Build set_client_DH_params
  const setDH = new Api.SetClientDHParams({
    nonce: nonceBig,
    serverNonce: expectedServerNonce,
    encryptedData: Buffer.from(encryptedData),
  });

  const setDHBody = serializeTLObject(setDH);
  const previousMsgId = state.lastMsgId ? BigInt(state.lastMsgId) : undefined;
  const { message, msgId } = wrapPlainMessage(setDHBody, timeOffset, previousMsgId);

  // Compute server_salt = new_nonce[0..8] XOR server_nonce[0..8]
  const serverSalt = new Uint8Array(8);
  for (let i = 0; i < 8; i++) {
    serverSalt[i] = newNonce[i] ^ serverNonce[i];
  }

  return {
    sendBytes: message,
    stateUpdates: {
      state: "DH_GEN_SENT",
      lastMsgId: msgId.toString(),
      authKey: toHex(authKey),
      authKeyId: toHex(authKeyId),
      serverSalt: toHex(serverSalt),
      timeOffset,
    },
  };
}

// ─── Step 4: Handle DH gen result ───

export async function handleDHGenResult(
  state: SessionState,
  payload: Uint8Array,
): Promise<{ success: boolean; stateUpdates: Partial<SessionState> }> {
  const { body } = unwrapPlainMessage(payload);
  const reader = createReader(body);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = reader.tgReadObject() as any;

  if (result.className === "DhGenOk") {
    if (!state.newNonce || !state.authKey) {
      throw new Error("missing DH state for DhGenOk verification");
    }
    const authKey = new GramJsAuthKey();
    await authKey.setKey(Buffer.from(fromHex(state.authKey)));
    const expected = await authKey.calcNewNonceHash(
      tlBigIntFromBytesLE(fromHex(state.newNonce)),
      1,
    );
    if (!result.newNonceHash1?.equals(expected)) {
      throw new Error("DhGenOk new_nonce_hash mismatch");
    }

    // Auth key established. Generate session_id.
    const sessionId = generateNonce(8);
    return {
      success: true,
      stateUpdates: {
        state: "AUTH_KEY_READY",
        sessionId: toHex(sessionId),
        seqNo: 0,
      },
    };
  } else if (result.className === "DhGenRetry") {
    throw new Error("DH gen retry requested — not implemented");
  } else if (result.className === "DhGenFail") {
    throw new Error("DH gen failed");
  } else {
    throw new Error(`unexpected DH gen result: ${result.className}`);
  }
}

// ─── Helper: Build auth.sendCode request ───

export function buildSendCode(
  state: SessionState,
  apiId: string,
  apiHash: string,
): { sendBytes: Uint8Array; stateUpdates: Partial<SessionState> } {
  const sendCode = new Api.auth.SendCode({
    phoneNumber: state.phone,
    apiId: parseInt(apiId, 10),
    apiHash: apiHash,
    settings: new Api.CodeSettings({}),
  });

  return buildEncryptedRequest(
    state,
    apiId,
    sendCode,
    "CODE_SENT",
  );
}

// ─── Helper: Build auth.signIn request ───

export function buildSignIn(
  state: SessionState,
  apiId: string,
  code: string,
): { sendBytes: Uint8Array; stateUpdates: Partial<SessionState> } {
  const signIn = new Api.auth.SignIn({
    phoneNumber: state.phone,
    phoneCodeHash: state.phoneCodeHash!,
    phoneCode: code,
  });

  return buildEncryptedRequest(state, apiId, signIn, "SIGN_IN_SENT");
}

export function normalizePasswordSrp(
  password: InstanceType<typeof Api.account.Password>,
): {
  passwordHint?: string;
  passwordSrp?: PasswordSrpState;
} {
  if (
    !password.currentAlgo ||
    password.currentAlgo.className !==
      "PasswordKdfAlgoSHA256SHA256PBKDF2HMACSHA512iter100000SHA256ModPow" ||
    !password.srp_B ||
    password.srpId === undefined
  ) {
    return {
      passwordHint: password.hint,
      passwordSrp: undefined,
    };
  }

  return {
    passwordHint: password.hint,
    passwordSrp: {
      algoClass:
        "PasswordKdfAlgoSHA256SHA256PBKDF2HMACSHA512iter100000SHA256ModPow",
      g: password.currentAlgo.g,
      pHex: toHex(new Uint8Array(password.currentAlgo.p)),
      salt1Hex: toHex(new Uint8Array(password.currentAlgo.salt1)),
      salt2Hex: toHex(new Uint8Array(password.currentAlgo.salt2)),
      srpBHex: toHex(new Uint8Array(password.srp_B)),
      srpId: password.srpId.toString(),
    },
  };
}

export function buildGetPassword(
  state: SessionState,
  apiId: string,
): { sendBytes: Uint8Array; stateUpdates: Partial<SessionState> } {
  return buildEncryptedRequest(
    state,
    apiId,
    new Api.account.GetPassword(),
    "PASSWORD_INFO_SENT",
  );
}

function reconstructPassword(
  passwordSrp: PasswordSrpState,
): InstanceType<typeof Api.account.Password> {
  return {
    currentAlgo:
      new Api.PasswordKdfAlgoSHA256SHA256PBKDF2HMACSHA512iter100000SHA256ModPow(
        {
          g: passwordSrp.g,
          p: Buffer.from(fromHex(passwordSrp.pHex)),
          salt1: Buffer.from(fromHex(passwordSrp.salt1Hex)),
          salt2: Buffer.from(fromHex(passwordSrp.salt2Hex)),
        },
      ),
    srp_B: Buffer.from(fromHex(passwordSrp.srpBHex)),
    srpId: BigInt(passwordSrp.srpId),
  } as InstanceType<typeof Api.account.Password>;
}

export async function buildCheckPassword(
  state: SessionState,
  apiId: string,
  password: string,
): Promise<{ sendBytes: Uint8Array; stateUpdates: Partial<SessionState> }> {
  if (!state.passwordSrp) {
    throw new Error("missing SRP password state");
  }
  const check = await computeCheck(
    reconstructPassword(state.passwordSrp),
    password,
  );
  return buildEncryptedRequest(
    state,
    apiId,
    new Api.auth.CheckPassword({ password: check }),
    "CHECK_PASSWORD_SENT",
  );
}

export function buildExportLoginToken(
  state: SessionState,
  apiId: string,
  apiHash: string,
): { sendBytes: Uint8Array; stateUpdates: Partial<SessionState> } {
  return buildEncryptedRequest(
    state,
    apiId,
    new Api.auth.ExportLoginToken({
      apiId: Number(apiId),
      apiHash,
      exceptIds: [],
    }),
    "QR_TOKEN_SENT",
  );
}

export function buildImportLoginToken(
  state: SessionState,
  apiId: string,
  tokenBase64Url: string,
): { sendBytes: Uint8Array; stateUpdates: Partial<SessionState> } {
  return buildEncryptedRequest(
    state,
    apiId,
    new Api.auth.ImportLoginToken({
      token: Buffer.from(tokenBase64Url, "base64url"),
    }),
    "QR_IMPORT_SENT",
  );
}

// ─── Helper: Build generic API method request ───

export function buildApiMethod(
  state: SessionState,
  apiId: string,
  methodName: string,
  params: Record<string, unknown>,
): { sendBytes: Uint8Array; stateUpdates: Partial<SessionState> } {
  // Resolve the API constructor from gramjs
  // e.g., "messages.GetDialogs" → Api.messages.GetDialogs
  const parts = methodName.split(".");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Constructor: any = Api;
  for (const part of parts) {
    Constructor = Constructor[part];
  }

  if (!Constructor) {
    throw new Error(`unknown API method: ${methodName}`);
  }

  const request = new Constructor(params);
  return buildEncryptedRequest(
    state,
    apiId,
    request,
    state.state,
  );
}
