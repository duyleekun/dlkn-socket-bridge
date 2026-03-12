/**
 * Main entry point for bridge callbacks after migration to gramjs-statemachine.
 *
 * Replaces the 1448-line onResponse() with a thin adapter:
 *   1. Load SerializedState + BridgeSession from KV
 *   2. Call step(state, inbound) from the library
 *   3. Persist nextState
 *   4. Send outbound bytes if present
 *   5. Dispatch each Action to handleAction()
 */

import { step } from "gramjs-statemachine";
import type { SerializedState } from "gramjs-statemachine";
import {
  loadBoth,
  saveSerializedState,
} from "../session-store";
import { sendBytes } from "../bridge-client";
import { isQuickAck } from "../transport";
import {
  isSocketGoneError,
  getSocketErrorStatus,
  cleanupSocket,
  markSocketState,
} from "../socket-health";
import { handleAction } from "./action-handler";
import type { Env } from "../types";

export async function onCallback(
  env: Env,
  workerUrl: string,
  sessionKey: string,
  rawFrame: Uint8Array,
): Promise<void> {
  // Quick-ack frames have no payload — ignore silently
  if (isQuickAck(rawFrame)) {
    console.log(`[on-callback] quick ack for ${sessionKey}, ignoring`);
    return;
  }

  const loaded = await loadBoth(env, sessionKey);
  if (!loaded) {
    console.warn(`[on-callback] no state for session ${sessionKey}`);
    return;
  }
  const { bridge } = loaded;
  let { state } = loaded;
  console.debug('[on-callback] inbound frame', {
    sessionKey,
    phase: state.phase,
    frameLength: rawFrame.length,
    socketId: bridge.socketId,
  });

  if (state.phase === "ERROR") {
    console.warn(`[on-callback] ignoring frame for errored session ${sessionKey}`, {
      frameLength: rawFrame.length,
      socketId: bridge.socketId,
      error: state.error?.message,
    });
    return;
  }

  try {
    // Check for a 4-byte MTProto server error code
    if (rawFrame.length === 4 + 4) {
      // transport frame: [4 len][4 payload]
      const inner = rawFrame.slice(4);
      if (inner.length === 4) {
        const view = new DataView(inner.buffer, inner.byteOffset, inner.byteLength);
        const code = view.getInt32(0, true);
        if (code < 0) {
          console.error('[on-callback] negative MTProto server error frame', {
            sessionKey,
            phase: state.phase,
            frameLength: rawFrame.length,
            serverErrorCode: code,
          });
          throw new Error(`MTProto server error: ${code} during ${state.phase}`);
        }
      }
    }

    // Step the state machine
    const result = await step(state, rawFrame);
    state = result.nextState;

    // 1. Always persist nextState first
    await saveSerializedState(env, sessionKey, state);

    // 2. Send outbound bytes if present (already framed by gramjs-statemachine)
    if (result.outbound) {
      await sendBridgeBytes(env, sessionKey, bridge.bridgeUrl, bridge.socketId, result.outbound);
    }

    // 3. Handle side-effect actions
    for (const action of result.actions) {
      await handleAction(env, workerUrl, sessionKey, state, bridge, action);
    }
  } catch (error) {
    console.error(`[on-callback] ${sessionKey} error:`, error);
    if (isSocketGoneError(error)) {
      await cleanupSocket(bridge.bridgeUrl, bridge.socketId);
      await markSocketState(
        env,
        sessionKey,
        getSocketErrorStatus(error),
        error instanceof Error ? error.message : String(error),
      );
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    if (state.phase === "ERROR" && state.error?.message) {
      return;
    }

    // Persist ERROR state
    const errorState: SerializedState = {
      ...state,
      phase: "ERROR",
      error: {
        message,
      },
    };
    await saveSerializedState(env, sessionKey, errorState);
  }
}

async function sendBridgeBytes(
  env: Env,
  sessionKey: string,
  bridgeUrl: string,
  socketId: string,
  message: Uint8Array,
): Promise<void> {
  try {
    await sendBytes(bridgeUrl, socketId, message);
  } catch (error) {
    if (isSocketGoneError(error)) {
      await cleanupSocket(bridgeUrl, socketId);
      await markSocketState(
        env,
        sessionKey,
        getSocketErrorStatus(error),
        error instanceof Error ? error.message : String(error),
      );
    }
    throw error;
  }
}
