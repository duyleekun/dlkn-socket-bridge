/**
 * Bridge callback handler backed by the higher-level gramjs-statemachine API.
 *
 * Flow:
 *   1. Load SessionSnapshot + BridgeSession from KV
 *   2. Call transitionSession(snapshot, inbound event)
 *   3. Persist snapshot
 *   4. Execute commands
 *   5. Process runtime session events
 */

import {
  transitionSession,
  type SessionSnapshot,
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
  executeSessionCommands,
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
    state: previousState.value,
    protocolPhase: previousState.context.protocolPhase,
    frameLength: rawFrame.length,
    socketId: bridge.socketId,
  });

  const result = await transitionSession(previousState, {
    type: "inbound_frame",
    frame: rawFrame,
  });
  await saveSerializedState(env, sessionKey, result.snapshot);

  try {
    bridge = await executeSessionCommands(
      env,
      workerUrl,
      sessionKey,
      bridge,
      result.commands,
    );

    bridge = await handleSessionEvents(
      env,
      sessionKey,
      previousState,
      result.snapshot,
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

    const latestState = result.snapshot;
    if (latestState.value !== "error") {
      const errorState: SessionSnapshot = {
        ...latestState,
        value: "error",
        context: {
          ...latestState.context,
          protocolPhase: "ERROR",
          error: {
            message: error instanceof Error ? error.message : String(error),
          },
        },
      };
      await saveSerializedState(env, sessionKey, errorState);
    }
  }
}
