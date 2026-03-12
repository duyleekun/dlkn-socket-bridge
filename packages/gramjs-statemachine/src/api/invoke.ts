/**
 * API invocation: encrypt a TL request and produce outbound bytes + updated state.
 */

import type { BigInteger } from 'big-integer';
import { Api } from 'telegram/tl/index.js';
import { LAYER } from 'telegram/tl/AllTLObjects.js';
import { BinaryWriter } from 'telegram/extensions/index.js';
import { generateRandomBytes } from 'telegram/Helpers.js';
import type { SerializedState } from '../types/state.js';
import type { StepResult } from '../types/step-result.js';
import { hydrateMtProtoState, readMtProtoSequence } from '../session/mtproto-session.js';
import { wrapTransportFrame } from '../framing/intermediate-codec.js';

type Primitive = string | number | boolean | bigint | symbol | null | undefined;
type AnyFunction = (...args: any[]) => unknown;
type TlInstance = { classType: 'constructor' | 'request' };
type TlConstructor = abstract new (...args: any[]) => TlInstance;
type TlRequestConstructor = abstract new (...args: any[]) => {
  classType: 'request';
  className?: string;
  getBytes(): Buffer;
};

type JoinPath<Prefix extends string, Key extends string> = Prefix extends ''
  ? Key
  : `${Prefix}.${Key}`;

type ApiMethodPathFrom<T, Prefix extends string = ''> =
  T extends Primitive | AnyFunction
    ? never
    : {
        [Key in Extract<keyof T, string>]:
          T[Key] extends TlRequestConstructor
            ? JoinPath<Prefix, Key>
            : T[Key] extends TlConstructor
              ? never
              : T[Key] extends object
                ? ApiMethodPathFrom<T[Key], JoinPath<Prefix, Key>>
                : never;
      }[Extract<keyof T, string>];

type ResolvePath<T, Path extends string> = Path extends `${infer Head}.${infer Rest}`
  ? Head extends keyof T
    ? ResolvePath<T[Head], Rest>
    : never
  : Path extends keyof T
    ? T[Path]
    : never;

type Expand<T> = T extends infer U ? { [Key in keyof U]: U[Key] } : never;

type RelaxTelegramInput<T> =
  T extends BigInteger
    ? T | bigint
    : T extends TlInstance
      ? T
      : T extends Buffer | Uint8Array | Date
        ? T
        : T extends readonly (infer Item)[]
          ? Array<RelaxTelegramInput<Item>>
          : T extends object
            ? Expand<{ [Key in keyof T]: RelaxTelegramInput<T[Key]> }>
            : T;

export type ApiMethodPath = ApiMethodPathFrom<typeof Api>;
type ApiMethodConstructor<M extends ApiMethodPath> =
  ResolvePath<typeof Api, M> extends TlRequestConstructor ? ResolvePath<typeof Api, M> : never;
export type ApiMethodParams<M extends ApiMethodPath> =
  RelaxTelegramInput<ConstructorParameters<ApiMethodConstructor<M>>[0]>;

type TlRequestLike = { getBytes(): Buffer; className?: string };
type TlRequestClass = {
  className?: string;
  classType?: string;
  new (args: unknown): TlRequestLike;
};

/**
 * Encrypt and frame a TL request for sending to Telegram.
 *
 * Automatically wraps in InitConnection + InvokeWithLayer on the first call.
 */
export async function sendApiRequest(
  state: SerializedState,
  request: TlRequestLike,
  opts?: { contentRelated?: boolean },
): Promise<StepResult> {
  // 1. Hydrate GramJS' encrypted session runtime from persisted worker state.
  const mtprotoState = hydrateMtProtoState(state);

  // 2. Wrap in InitConnection if this is the first call
  const actualRequest = state.connectionInited
    ? request
    : wrapInInitConnection(state.apiId, request);

  // 3. Serialize
  const body = new Uint8Array(actualRequest.getBytes());

  // 4. Let GramJS write the inner message header and encrypt the envelope.
  const contentRelated = opts?.contentRelated !== false;
  const writer = new BinaryWriter(Buffer.alloc(0));
  const msgId = await mtprotoState.writeDataAsMessage(
    writer,
    Buffer.from(body),
    contentRelated,
  );
  const encrypted = await mtprotoState.encryptMessageData(writer.getValue());

  // 5. Wrap transport frame
  const outbound = wrapTransportFrame(new Uint8Array(encrypted));

  // 6. Persist the state mutations GramJS applied while writing the message.
  const requestName = (request as { className?: string }).className ?? 'Unknown';
  const nextState: SerializedState = {
    ...state,
    lastMsgId: msgId.toString(),
    sequence: readMtProtoSequence(mtprotoState),
    connectionInited: true,
    pendingRequests: {
      ...state.pendingRequests,
      [msgId.toString()]: { requestName },
    },
  };

  // 7. Return
  return { nextState, outbound, actions: [] };
}

/**
 * Resolve a dotted GramJS request name and send it through the same framing path
 * as manually constructed TL requests.
 */
export async function sendApiMethod<M extends ApiMethodPath>(
  state: SerializedState,
  method: M,
  params: ApiMethodParams<M>,
  opts?: { contentRelated?: boolean },
): Promise<StepResult> {
  const RequestClass = resolveApiRequestClass(method);
  return sendApiRequest(
    state,
    new RequestClass(params) as TlRequestLike,
    opts,
  );
}

function resolveApiRequestClass(method: string): TlRequestClass {
  let current: unknown = Api;

  for (const segment of method.split('.')) {
    if (!segment) {
      throw new Error(`Unknown API method: ${method}`);
    }
    current = (current as Record<string, unknown> | undefined)?.[segment];
    if (!current) {
      throw new Error(`Unknown API method: ${method}`);
    }
  }

  if (typeof current !== 'function') {
    throw new Error(`API path is not a request: ${method}`);
  }

  const RequestClass = current as TlRequestClass;
  if (RequestClass.classType !== 'request') {
    throw new Error(`API path is not a request: ${method}`);
  }

  return RequestClass;
}

/**
 * Wrap a TL query in InvokeWithLayer + InitConnection.
 * Called automatically on the first API request of a session.
 */
function wrapInInitConnection(
  apiId: string,
  query: { getBytes(): Buffer },
): Api.InvokeWithLayer {
  return new Api.InvokeWithLayer({
    layer: LAYER,
    query: new Api.InitConnection({
      apiId: parseInt(apiId, 10),
      deviceModel: 'gramjs-statemachine',
      systemVersion: '1.0',
      appVersion: '1.0',
      systemLangCode: 'en',
      langCode: 'en',
      langPack: '',
      query,
    }),
  });
}

/**
 * Generate a random 64-bit signed integer (as bigint).
 */
export async function randomLong(): Promise<bigint> {
  const bytes = new Uint8Array(await generateRandomBytes(8));
  const view = new DataView(bytes.buffer);
  return BigInt.asIntN(64, view.getBigInt64(0, true));
}
