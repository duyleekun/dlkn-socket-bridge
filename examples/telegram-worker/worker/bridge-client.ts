import type { BridgeCreateResponse, BridgeStatusResponse } from "./types";

export class BridgeRequestError extends Error {
  status?: number;
  body?: string;

  constructor(message: string, status?: number, body?: string) {
    super(message);
    this.name = "BridgeRequestError";
    this.status = status;
    this.body = body;
  }
}

async function readError(res: Response, prefix: string): Promise<never> {
  const text = await res.text();
  throw new BridgeRequestError(
    `${prefix} (${res.status}): ${text}`,
    res.status,
    text,
  );
}

/**
 * HTTP wrapper for the dlkn-socket-bridge REST API.
 *
 * Bridge endpoints:
 *   POST   /sockets          — create a new socket session
 *   POST   /sockets/:id      — send binary data to the socket
 *   GET    /sockets/:id      — get session status
 *   DELETE /sockets/:id      — close the session
 */

export async function createSession(
  bridgeUrl: string,
  targetUrl: string,
  callbackUrl: string,
): Promise<BridgeCreateResponse> {
  const res = await fetch(`${bridgeUrl}/sockets`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      target_url: targetUrl,
      callback_url: callbackUrl,
    }),
  });
  if (!res.ok) {
    await readError(res, "bridge createSession failed");
  }
  return res.json() as Promise<BridgeCreateResponse>;
}

export async function sendBytes(
  bridgeUrl: string,
  socketId: string,
  data: Uint8Array,
): Promise<void> {
  const res = await fetch(`${bridgeUrl}/sockets/${socketId}`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer,
  });
  if (!res.ok) {
    await readError(res, "bridge sendBytes failed");
  }
}

export async function getStatus(
  bridgeUrl: string,
  socketId: string,
): Promise<BridgeStatusResponse> {
  const res = await fetch(`${bridgeUrl}/sockets/${socketId}`, {
    method: "GET",
  });
  if (!res.ok) {
    await readError(res, "bridge getStatus failed");
  }
  return res.json() as Promise<BridgeStatusResponse>;
}

export async function closeSession(
  bridgeUrl: string,
  socketId: string,
): Promise<void> {
  const res = await fetch(`${bridgeUrl}/sockets/${socketId}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    await readError(res, "bridge closeSession failed");
  }
}
