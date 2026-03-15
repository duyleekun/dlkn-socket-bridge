/**
 * Bridge callback handler backed by the zca-js-statemachine API.
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
  type ZaloSessionTransitionResult,
} from "zca-js-statemachine";
import {
  loadBoth,
  saveBridgeSession,
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
  appendSocketActivityBatch,
  buildRecoveryCommands,
  resolveMessageRecoveryCursor,
} from "../runtime-store";
import {
  executeSessionCommands,
} from "../bridge-session";
import { describeRxFrame } from "../socket-activity";
import type { BridgeSession, Env } from "../types";

async function persistAndExecuteTransition(
  env: Env,
  workerUrl: string,
  sessionKey: string,
  bridge: BridgeSession,
  result: ZaloSessionTransitionResult,
): Promise<Awaited<ReturnType<typeof executeSessionCommands>>> {
  await saveSerializedState(env, sessionKey, result.snapshot);
  const nextBridge = await executeSessionCommands(
    env,
    workerUrl,
    sessionKey,
    bridge,
    result.commands,
  );
  await handleSessionEvents(
    env,
    sessionKey,
    result.events,
  );
  return nextBridge;
}

async function requestOfflineBacklogIfNeeded(
  env: Env,
  workerUrl: string,
  sessionKey: string,
  previousState: SessionSnapshot,
  nextState: SessionSnapshot,
  bridge: BridgeSession,
): Promise<BridgeSession> {
  if (!bridge.pendingBacklogRecovery) {
    return bridge;
  }
  if (previousState.value === "listening" || nextState.value !== "listening") {
    return bridge;
  }

  const cursor = await resolveMessageRecoveryCursor(env, sessionKey);
  const commands = buildRecoveryCommands(cursor);

  const updatedBridge: BridgeSession = {
    ...bridge,
    pendingBacklogRecovery: false,
  };
  await saveBridgeSession(env, sessionKey, updatedBridge);

  if (commands.length === 0) {
    return updatedBridge;
  }

  return executeSessionCommands(
    env,
    workerUrl,
    sessionKey,
    updatedBridge,
    commands,
  );
}

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
    phase: previousState.context.phase,
    frameLength: rawFrame.length,
    socketId: bridge.socketId,
  });

  const result = await transitionSession(previousState, {
    type: "inbound_frame",
    frame: rawFrame,
  });
  const socketActivity = await describeRxFrame(previousState, rawFrame);

  try {
    await appendSocketActivityBatch(env, sessionKey, socketActivity);
    bridge = await persistAndExecuteTransition(
      env,
      workerUrl,
      sessionKey,
      bridge,
      result,
    );
    bridge = await requestOfflineBacklogIfNeeded(
      env,
      workerUrl,
      sessionKey,
      previousState,
      result.snapshot,
      bridge,
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
          phase: "error",
          errorMessage: error instanceof Error ? error.message : String(error),
        },
      };
      await saveSerializedState(env, sessionKey, errorState);
    }
  }
}

export async function onSocketClosed(
  env: Env,
  workerUrl: string,
  sessionKey: string,
  close: { code?: number; reason?: string },
): Promise<void> {
  const loaded = await loadBoth(env, sessionKey);
  if (!loaded) {
    console.warn(`[on-socket-closed] no state for session ${sessionKey}`);
    return;
  }

  const reason = close.reason || "unknown";
  const code = close.code ?? 1000;
  let { bridge } = loaded;
  const result = await transitionSession(loaded.state, {
    type: "ws_closed",
    code,
    reason,
  });

  try {
    const nextBridge = await persistAndExecuteTransition(
      env,
      workerUrl,
      sessionKey,
      bridge,
      result,
    );
    const requestedReconnect = result.commands.some((command) => command.type === "reconnect");
    if (!requestedReconnect) {
      await markSocketState(
        env,
        sessionKey,
        "closed",
        `connection closed: ${reason}`,
      );
    } else {
      bridge = {
        ...nextBridge,
        pendingBacklogRecovery: true,
      };
      await saveBridgeSession(env, sessionKey, bridge);
      await markSocketState(
        env,
        sessionKey,
        bridge.socketStatus,
      );
    }
  } catch (error) {
    console.error(`[on-socket-closed] ${sessionKey} error:`, error);
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
          phase: "error",
          errorMessage: error instanceof Error ? error.message : String(error),
        },
      };
      await saveSerializedState(env, sessionKey, errorState);
    }
  }
}
