/**
 * Runtime event handler for the worker example.
 *
 * The package now emits decrypted MTProto frames. This module persists the
 * authenticated session and keeps a bounded debug log for the UI.
 */
import {
  extractTelegramUpdatesState,
  classifyDecryptedFrame,
  getTlObjectClassName,
  normalizeTlValue,
  parseRpcResultFrame,
  type SessionEvent,
  type SessionSnapshot,
} from "gramjs-statemachine";
import {
  persistReadySession,
  savePersistedSessionUpdatesState,
  saveBridgeSession,
} from "../session-store";
import {
  appendPacketLog,
} from "../runtime-store";
import type {
  BridgeSession,
  Env,
  ParsedPacketEntry,
} from "../types";

async function summarizeEvent(
  event: SessionEvent,
  rpc?: Awaited<ReturnType<typeof parseRpcResultFrame>>,
): Promise<string> {
  const parsedRpc = rpc ?? await parseRpcResultFrame(event.object, {
    requestName: event.requestName,
  });
  const kind = classifyDecryptedFrame(event.object);
  if (kind === "rpc_result") {
    if (parsedRpc?.error) {
      return `${parsedRpc.requestName || "RPC"} failed`;
    }
    if (parsedRpc?.requestName === "updates.GetDifference") {
      return "updates.GetDifference catch-up result";
    }
    return `${parsedRpc?.requestName || "RPC"} result`;
  }
  if (kind === "update") {
    return getTlObjectClassName(event.object) || "Update";
  }
  if (kind === "service") {
    return getTlObjectClassName(event.object) || "Service frame";
  }
  return "Unknown frame";
}

async function toPacketEntry(event: SessionEvent): Promise<ParsedPacketEntry> {
  const kind = classifyDecryptedFrame(event.object);
  const rpc = await parseRpcResultFrame(event.object, { requestName: event.requestName });

  return {
    id: `frame:${event.msgId}:${event.seqNo}`,
    msgId: event.msgId,
    seqNo: event.seqNo,
    receivedAt: Date.now(),
    kind,
    topLevelClassName: getTlObjectClassName(event.object),
    reqMsgId: rpc?.reqMsgId,
    requestName: rpc?.requestName ?? event.requestName,
    resultClassName: rpc?.resultClassName,
    error: rpc?.error?.message,
    summary: await summarizeEvent(event, rpc),
    payload: rpc?.normalizedResult ?? normalizeTlValue(event.object),
  };
}

export async function handleSessionEvents(
  env: Env,
  sessionKey: string,
  previousState: SessionSnapshot,
  nextState: SessionSnapshot,
  bridge: BridgeSession,
  events: SessionEvent[],
): Promise<BridgeSession> {
  let currentBridge = bridge;
  let updatesState = bridge.updatesState ?? null;
  let nextUpdatesState = updatesState;

  const packetEntries = await Promise.all(events.map(async (event) => {
    const extractedState = await extractTelegramUpdatesState(event, nextUpdatesState);
    if (extractedState) {
      nextUpdatesState = extractedState;
    }
    return toPacketEntry(event);
  }));

  if (previousState.value !== "ready" && nextState.value === "ready") {
    currentBridge = await persistReadySession(
      env,
      sessionKey,
      nextState,
      bridge,
      nextState.context.user,
      nextUpdatesState,
    );
  }

  const writes: Promise<unknown>[] = [
    appendPacketLog(env, sessionKey, packetEntries),
  ];

  if (nextUpdatesState) {
    const changed = !updatesState
      || updatesState.pts !== nextUpdatesState.pts
      || updatesState.qts !== nextUpdatesState.qts
      || updatesState.date !== nextUpdatesState.date
      || updatesState.seq !== nextUpdatesState.seq
      || updatesState.source !== nextUpdatesState.source;
    if (changed) {
      currentBridge = {
        ...currentBridge,
        updatesState: nextUpdatesState,
      };
      writes.push(saveBridgeSession(env, sessionKey, currentBridge));
      if (currentBridge.persistedSessionRef) {
        writes.push(
          savePersistedSessionUpdatesState(
            env,
            currentBridge.persistedSessionRef,
            nextUpdatesState,
          ),
        );
      }
    }
  }

  await Promise.all(writes);

  return currentBridge;
}
