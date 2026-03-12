import { Api, sendApiMethod, createInitialState } from "../src/index.js";

const readyState = {
  ...createInitialState({ apiId: "1", apiHash: "h" }),
  phase: "READY" as const,
  connectionInited: true,
  authKey: "aa".repeat(256),
  authKeyId: "bb".repeat(8),
  serverSalt: "cc".repeat(8),
  sessionId: "dd".repeat(8),
};

await sendApiMethod(readyState, "messages.GetDialogs", {
  offsetDate: 0,
  offsetId: 0,
  offsetPeer: new Api.InputPeerEmpty(),
  limit: 20,
  hash: 0n,
});

await sendApiMethod(readyState, "messages.SendMessage", {
  peer: new Api.InputPeerSelf(),
  message: "hello",
  randomId: 1n,
  noWebpage: true,
});

// @ts-expect-error invalid method path
await sendApiMethod(readyState, "messages.DoesNotExist", {});

// @ts-expect-error missing required message field
await sendApiMethod(readyState, "messages.SendMessage", {
  peer: new Api.InputPeerSelf(),
});

// @ts-expect-error wrong property name
await sendApiMethod(readyState, "messages.SendMessage", {
  peer: new Api.InputPeerSelf(),
  message: "hello",
  nope: true,
});
