/**
 * Runtime event handler for the worker example.
 *
 * Protocol follow-up behavior now lives inside `gramjs-statemachine`.
 * This module only performs example-specific persistence and caching.
 */
import type { SerializedState, SessionEvent } from "gramjs-statemachine";
import {
  persistReadySession,
} from "../session-store";
import {
  appendPacketLog,
  resolvePendingRequest,
  saveConversationCache,
} from "../runtime-store";
import { buildConversationCacheFromDialogs } from "../inbound";
import type { BridgeSession, Env } from "../types";

export async function handleSessionEvents(
  env: Env,
  sessionKey: string,
  previousState: SerializedState,
  nextState: SerializedState,
  bridge: BridgeSession,
  events: SessionEvent[],
): Promise<BridgeSession> {
  let currentBridge = bridge;

  if (previousState.phase !== "READY" && nextState.phase === "READY") {
    currentBridge = await persistReadySession(
      env,
      sessionKey,
      nextState,
      bridge,
      nextState.user,
    );
  }

  for (const event of events) {
    switch (event.type) {
      case "rpc_result":
        await handleRpcResult(env, sessionKey, event);
        break;

      case "update":
        await appendPacketLog(env, sessionKey, [
          {
            id: `update:${Date.now()}`,
            msgId: event.msgId,
            seqNo: event.seqNo,
            receivedAt: Date.now(),
            requiresAck: false,
            className:
              (event.update as { className?: string })?.className || "Update",
            envelopeClassName: event.envelopeClassName,
            payload: event.update,
          },
        ]);
        break;

      default: {
        const _exhaustive: never = event;
        void _exhaustive;
      }
    }
  }

  return currentBridge;
}

async function handleRpcResult(
  env: Env,
  sessionKey: string,
  event: Extract<SessionEvent, { type: "rpc_result" }>,
): Promise<void> {
  const request = await resolvePendingRequest(env, sessionKey, event.reqMsgId);
  if (request) {
    await env.TG_KV.put(
      `result:${sessionKey}:${request.requestId}`,
      JSON.stringify({
        requestId: request.requestId,
        kind: request.kind,
        method: request.method,
        reqMsgId: event.reqMsgId,
        className: event.requestName,
        payload: event.result,
        receivedAt: Date.now(),
      }),
      { expirationTtl: 300 },
    );
  }

  const cache = buildConversationCacheFromDialogs(event.result);
  if (cache) {
    await saveConversationCache(env, sessionKey, cache);
  }
}
