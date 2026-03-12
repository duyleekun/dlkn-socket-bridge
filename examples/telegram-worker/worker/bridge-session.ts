/**
 * Worker-owned bridge/session helpers.
 *
 * These are the pieces that remain outside `gramjs-statemachine`: sending
 * bytes through the Rust bridge, persisting state before outbound writes, and
 * rotating bridge sessions when the package requests a reconnect.
 */
import type { SerializedState, TransportDirective } from "gramjs-statemachine";
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

export async function persistStateAndSend(
  env: Env,
  sessionKey: string,
  bridge: BridgeSession,
  nextState: SerializedState,
  outbound: Uint8Array,
  extraWrites: Promise<unknown>[] = [],
): Promise<void> {
  // Persist first so the worker can safely resume after any bridge send error.
  await Promise.all([
    saveSerializedState(env, sessionKey, nextState),
    ...extraWrites,
  ]);
  await sendBridgeBytes(env, sessionKey, bridge, outbound);
}

export async function applyReconnectDirective(
  env: Env,
  workerUrl: string,
  sessionKey: string,
  bridge: BridgeSession,
  directive: Extract<TransportDirective, { type: "reconnect" }>,
): Promise<BridgeSession> {
  const newCallbackKey = crypto.randomUUID();
  const normalizedWorkerUrl = normalizeUrl(workerUrl);
  const bridgeResp = await createSession(
    bridge.bridgeUrl,
    `mtproto-frame://${directive.dcIp}:${directive.dcPort}`,
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
