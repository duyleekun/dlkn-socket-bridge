import {
  BridgeRequestError,
  closeSession,
  getStatus as getBridgeStatus,
} from "./bridge-client";
import { resolveBridgeUrl } from "./bridge-url";
import {
  loadSessionState,
  saveSessionState,
  updatePersistedLinkFromState,
} from "./session-store";
import type {
  BridgeSocketHealth,
  Env,
  SessionState,
  SocketStatus,
} from "./types";

function classifyBridgeError(error: unknown): {
  status: SocketStatus;
  message: string;
} {
  if (error instanceof BridgeRequestError) {
    const body = error.body || "";
    if (error.status === 404) {
      return { status: "closed", message: body || "bridge socket not found" };
    }
    if (
      error.status === 410 ||
      body.includes("command channel closed") ||
      body.includes("session command channel closed")
    ) {
      return { status: "stale", message: body || "bridge socket stale" };
    }
    return {
      status: "error",
      message: body || error.message,
    };
  }
  return {
    status: "error",
    message: error instanceof Error ? error.message : String(error),
  };
}

export async function cleanupSocket(
  bridgeUrl: string,
  socketId: string | undefined,
): Promise<void> {
  if (!socketId) {
    return;
  }
  try {
    await closeSession(resolveBridgeUrl(bridgeUrl), socketId);
  } catch (error) {
    if (error instanceof BridgeRequestError && error.status === 404) {
      return;
    }
    console.warn(`[socket-health] failed to close socket ${socketId}:`, error);
  }
}

export async function markSocketState(
  env: Env,
  sessionKey: string,
  socketStatus: SocketStatus,
  error?: string,
): Promise<SessionState | null> {
  const state = await loadSessionState(env, sessionKey);
  if (!state) {
    return null;
  }
  const now = Date.now();
  const nextState: SessionState = {
    ...state,
    state: state.state === "READY" ? "READY" : socketStatus === "healthy" ? state.state : "ERROR",
    socketStatus,
    socketLastCheckedAt: now,
    socketLastHealthyAt:
      socketStatus === "healthy"
        ? now
        : state.socketLastHealthyAt,
    error: socketStatus === "healthy" ? undefined : error || state.error,
  };
  await saveSessionState(env, sessionKey, nextState);
  await updatePersistedLinkFromState(env, sessionKey, nextState, socketStatus);
  return nextState;
}

export async function probeBridgeSocket(
  env: Env,
  sessionKey: string,
  state?: SessionState | null,
): Promise<BridgeSocketHealth> {
  const currentState = state ?? await loadSessionState(env, sessionKey);
  const now = Date.now();
  if (!currentState) {
    return {
      status: "unknown",
      socketId: "",
      lastCheckedAt: now,
      error: "session not found",
    };
  }

  try {
    const bridgeStatus = await getBridgeStatus(
      resolveBridgeUrl(currentState.bridgeUrl),
      currentState.socketId,
    );
    const nextState: SessionState = {
      ...currentState,
      socketStatus: "healthy",
      socketLastCheckedAt: now,
      socketLastHealthyAt: now,
      error: currentState.state === "READY" ? undefined : currentState.error,
    };
    await saveSessionState(env, sessionKey, nextState);
    await updatePersistedLinkFromState(env, sessionKey, nextState, "healthy");
    return {
      status: "healthy",
      socketId: currentState.socketId,
      uptimeSecs: bridgeStatus.uptime_secs,
      bytesRx: bridgeStatus.bytes_rx,
      bytesTx: bridgeStatus.bytes_tx,
      lastCheckedAt: now,
    };
  } catch (error) {
    const classified = classifyBridgeError(error);
    await markSocketState(env, sessionKey, classified.status, classified.message);
    return {
      status: classified.status,
      socketId: currentState.socketId,
      lastCheckedAt: now,
      error: classified.message,
    };
  }
}

export function isSocketGoneError(error: unknown): boolean {
  const classified = classifyBridgeError(error);
  return classified.status === "closed" || classified.status === "stale";
}

export function getSocketErrorStatus(error: unknown): SocketStatus {
  return classifyBridgeError(error).status;
}
