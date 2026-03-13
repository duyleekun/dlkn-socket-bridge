/**
 * Worker-owned bridge/session helpers.
 *
 * These are the pieces that remain outside `gramjs-statemachine`: sending
 * bytes through the Rust bridge, persisting state before outbound writes, and
 * rotating bridge sessions when the package requests a reconnect.
 */
import type { SessionCommand, SessionSnapshot } from "gramjs-statemachine";
import { createSession, sendBytes } from "./bridge-client";
import { normalizeUrl, resolveBridgeUrl } from "./bridge-url";
import {
  deleteCallbackBinding,
  saveBridgeSession,
  saveCallbackBinding,
  saveSerializedState,
} from "./session-store";
import {
  cleanupSocket,
  getSocketErrorStatus,
  isSocketGoneError,
  markSocketState,
} from "./socket-health";
import type { BridgeSession, Env } from "./types";

export async function sendBridgeBytes(
  env: Env,
  sessionKey: string,
  bridge: BridgeSession,
  bytes: Uint8Array,
): Promise<void> {
  const bridgeUrl = resolveBridgeUrl(bridge.bridgeUrl);
  try {
    await sendBytes(bridgeUrl, bridge.socketId, bytes);
  } catch (error) {
    if (isSocketGoneError(error)) {
      await cleanupSocket(bridgeUrl, bridge.socketId);
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

export async function persistStateAndExecute(
  env: Env,
  workerUrl: string,
  sessionKey: string,
  bridge: BridgeSession,
  nextState: SessionSnapshot,
  commands: SessionCommand[],
  extraWrites: Promise<unknown>[] = [],
): Promise<BridgeSession> {
  // Persist first so the worker can safely resume after any bridge send error.
  await Promise.all([
    saveSerializedState(env, sessionKey, nextState),
    ...extraWrites,
  ]);
  return executeSessionCommands(env, workerUrl, sessionKey, bridge, commands);
}

export async function applyReconnectCommand(
  env: Env,
  workerUrl: string,
  sessionKey: string,
  bridge: BridgeSession,
  command: Extract<SessionCommand, { type: "reconnect" }>,
): Promise<BridgeSession> {
  const newCallbackKey = crypto.randomUUID();
  const normalizedWorkerUrl = normalizeUrl(workerUrl);
  const bridgeResp = await createSession(
    bridge.bridgeUrl,
    `mtproto-frame://${command.dcIp}:${command.dcPort}`,
    `${normalizedWorkerUrl}/cb/${newCallbackKey}`,
  );

  const nextBridge: BridgeSession = {
    ...bridge,
    callbackKey: newCallbackKey,
    socketId: bridgeResp.socket_id,
    socketStatus: "unknown",
    socketLastCheckedAt: undefined,
    socketLastHealthyAt: undefined,
  };

  await Promise.all([
    saveBridgeSession(env, sessionKey, nextBridge),
    saveCallbackBinding(env, newCallbackKey, sessionKey),
    deleteCallbackBinding(env, bridge.callbackKey),
  ]);

  await cleanupSocket(bridge.bridgeUrl, bridge.socketId);
  return nextBridge;
}

export async function executeSessionCommands(
  env: Env,
  workerUrl: string,
  sessionKey: string,
  bridge: BridgeSession,
  commands: SessionCommand[],
): Promise<BridgeSession> {
  let currentBridge = bridge;

  for (const command of commands) {
    switch (command.type) {
      case "send_frame":
        await sendBridgeBytes(env, sessionKey, currentBridge, command.frame);
        break;

      case "reconnect":
        currentBridge = await applyReconnectCommand(
          env,
          workerUrl,
          sessionKey,
          currentBridge,
          command,
        );
        await sendBridgeBytes(env, sessionKey, currentBridge, command.firstFrame);
        break;

      default: {
        const _exhaustive: never = command;
        void _exhaustive;
      }
    }
  }

  return currentBridge;
}
