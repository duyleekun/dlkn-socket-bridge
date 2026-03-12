/**
 * Bridge callback handler backed by the higher-level gramjs-statemachine API.
 *
 * Flow:
 *   1. Load SerializedState + BridgeSession from KV
 *   2. Call advanceSession(state, inbound)
 *   3. Persist nextState
 *   4. Execute reconnect directive when present
 *   5. Send outbound bytes
 *   6. Process runtime session events
 */

import {
  advanceSession,
  type SerializedState,
} from "gramjs-statemachine";
import {
  loadBoth,
  saveSerializedState,
} from "../session-store";
import {
  isSocketGoneError,
  getSocketErrorStatus,
  cleanupSocket,
  markSocketState,
} from "../socket-health";
import { handleSessionEvents } from "./action-handler";
import {
  applyReconnectDirective,
  sendBridgeBytes,
} from "../bridge-session";
import type { Env } from "../types";

export async function onCallback(
  env: Env,
  workerUrl: string,
  sessionKey: string,
  rawFrame: Uint8Array,
): Promise<void> {
  const loaded = await loadBoth(env, sessionKey);
  if (!loaded) {
    console.warn(`[on-callback] no state for session ${sessionKey}`);
    return;
  }
  let { bridge } = loaded;
  const previousState = loaded.state;
  console.debug("[on-callback] inbound frame", {
    sessionKey,
    phase: previousState.phase,
    frameLength: rawFrame.length,
    socketId: bridge.socketId,
  });

  const result = await advanceSession(previousState, rawFrame);
  await saveSerializedState(env, sessionKey, result.nextState);

  try {
    if (result.transport?.type === "reconnect") {
      bridge = await applyReconnectDirective(
        env,
        workerUrl,
        sessionKey,
        bridge,
        result.transport,
      );
      await sendBridgeBytes(env, sessionKey, bridge, result.transport.firstOutbound);
    }

    for (const outbound of result.outbound) {
      await sendBridgeBytes(env, sessionKey, bridge, outbound);
    }

    bridge = await handleSessionEvents(
      env,
      sessionKey,
      previousState,
      result.nextState,
      bridge,
      result.events,
    );
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

    const latestState = result.nextState;
    if (latestState.phase !== "ERROR") {
      const errorState: SerializedState = {
        ...latestState,
        phase: "ERROR",
        error: {
          message: error instanceof Error ? error.message : String(error),
        },
      };
      await saveSerializedState(env, sessionKey, errorState);
    }
  }
}
