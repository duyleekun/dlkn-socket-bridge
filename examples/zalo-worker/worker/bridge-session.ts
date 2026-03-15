/**
 * Worker-owned bridge/session helpers.
 *
 * These are the pieces that remain outside `zca-js-statemachine`: sending
 * bytes through the Rust bridge, persisting state before outbound writes, and
 * rotating bridge sessions when the package requests a reconnect.
 */
import type { ZaloSessionCommand, SessionSnapshot } from "zca-js-statemachine";
import { buildOldMessagesFrame, buildPingFrame } from "zca-js-statemachine";
import { createSession, sendBytes } from "./bridge-client";
import { normalizeUrl, resolveBridgeUrl } from "./bridge-url";
import {
  deleteCallbackBinding,
  deletePersistedSessionArtifacts,
  saveBridgeSession,
  saveCallbackBinding,
  savePersistedSession,
  saveSerializedState,
} from "./session-store";
import {
  cleanupSocket,
  getSocketErrorStatus,
  isSocketGoneError,
  markSocketState,
} from "./socket-health";
import { appendSocketActivity } from "./runtime-store";
import { describeTxFrame } from "./socket-activity";
import type { BridgeSession, Env, PersistedZaloSession } from "./types";

export async function sendBridgeBytes(
  env: Env,
  sessionKey: string,
  bridge: BridgeSession,
  bytes: Uint8Array,
): Promise<void> {
  const bridgeUrl = resolveBridgeUrl(bridge.bridgeUrl);
  try {
    await sendBytes(bridgeUrl, bridge.socketId, bytes);
    await appendSocketActivity(
      env,
      sessionKey,
      describeTxFrame(bytes),
    );
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
  commands: ZaloSessionCommand[],
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
  command: Extract<ZaloSessionCommand, { type: "reconnect" }>,
): Promise<BridgeSession> {
  const newCallbackKey = crypto.randomUUID();
  const normalizedWorkerUrl = normalizeUrl(workerUrl);
  const resolvedBridgeUrl = resolveBridgeUrl(bridge.bridgeUrl);

  const bridgeResp = await createSession(
    resolvedBridgeUrl,
    command.wsUrl,
    `${normalizedWorkerUrl}/cb/${newCallbackKey}`,
    { headers: command.headers },
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
  commands: ZaloSessionCommand[],
): Promise<BridgeSession> {
  let currentBridge = bridge;

  for (const command of commands) {
    switch (command.type) {
      case "send_ping": {
        const pingFrame = buildPingFrame();
        await sendBridgeBytes(env, sessionKey, currentBridge, pingFrame);
        break;
      }

      case "request_old_messages": {
        const frame = buildOldMessagesFrame(
          command.threadType,
          command.lastMessageId,
        );
        await sendBridgeBytes(env, sessionKey, currentBridge, frame);
        break;
      }

      case "reconnect":
        currentBridge = await applyReconnectCommand(
          env,
          workerUrl,
          sessionKey,
          currentBridge,
          command,
        );
        break;

      case "persist_credentials": {
        const persistedSessionRef = currentBridge.persistedSessionRef || crypto.randomUUID();
        const now = Date.now();
        const record: PersistedZaloSession = {
          version: 1,
          persistedSessionRef,
          credentials: command.credentials,
          userProfile: command.userProfile,
          wsUrl: command.wsUrl,
          pingIntervalMs: command.pingIntervalMs,
          createdAt: now,
          updatedAt: now,
        };
        await savePersistedSession(env, record);
        if (!currentBridge.persistedSessionRef) {
          currentBridge = { ...currentBridge, persistedSessionRef };
          await saveBridgeSession(env, sessionKey, currentBridge);
        }
        break;
      }

      case "clear_credentials":
        if (currentBridge.persistedSessionRef) {
          await deletePersistedSessionArtifacts(env, currentBridge.persistedSessionRef);
          currentBridge = {
            ...currentBridge,
            persistedSessionRef: undefined,
          };
          await saveBridgeSession(env, sessionKey, currentBridge);
        }
        break;

      case "http_login_qr":
      case "http_login_creds":
        // These are handled by server actions, not by the bridge command loop
        console.debug(`[bridge-session] skipping ${command.type} (handled by server actions)`);
        break;

      default: {
        const _exhaustive: never = command;
        void _exhaustive;
      }
    }
  }

  return currentBridge;
}
