/**
 * socket-bridge-worker — unified Worker entry point.
 *
 * Routes:
 *   POST /cb/:callbackKey  → route to TelegramAgent or ZaloAgent DO RPC
 *   GET|POST /agents/**    → routeAgentRequest (WebSocket + HTTP)
 *   Everything else        → vinext (Next.js UI)
 */

import handler from "vinext/server/app-router-entry";
import { routeAgentRequest } from "agents";
import { TelegramAgent } from "../agents/telegram-agent";
import { ZaloAgent } from "../agents/zalo-agent";
import type { CallbackRecord, Env } from "../agents/shared/types";
export { TelegramAgent, ZaloAgent };

type CallbackAgentStub = {
  pushFrame(b: ArrayBuffer): Promise<void>;
  onSocketClosed(code: number, reason: string): Promise<void>;
};

function getAgentStub(
  namespace: DurableObjectNamespace,
  record: CallbackRecord,
): CallbackAgentStub {
  if (record.instanceId) {
    try {
      return namespace.get(
        namespace.idFromString(record.instanceId),
      ) as unknown as CallbackAgentStub;
    } catch {
      // Legacy records used the instance name in the instanceId field.
    }
  }

  if (!record.instanceName) {
    throw new Error("Callback record is missing agent routing information");
  }

  return namespace.get(
    namespace.idFromName(record.instanceName),
  ) as unknown as CallbackAgentStub;
}

function isJsonCloseEvent(bytes: Uint8Array): boolean {
  try {
    const text = new TextDecoder().decode(bytes);
    const json = JSON.parse(text) as { event?: string };
    return json.event === "closed";
  } catch {
    return false;
  }
}

function parseCloseEvent(bytes: Uint8Array): { code: number; reason: string } {
  try {
    const text = new TextDecoder().decode(bytes);
    const json = JSON.parse(text) as { code?: number; reason?: string };
    return {
      // Rust close callbacks currently omit websocket close codes.
      // Preserve that ambiguity so agents don't misclassify generic bridge
      // disconnects as a remote logout.
      code: json.code ?? 1006,
      reason: json.reason ?? "unknown",
    };
  } catch {
    return { code: 1006, reason: "unknown" };
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // 1. Bridge callbacks from Rust bridge
    if (req.method === "POST" && url.pathname.startsWith("/cb/")) {
      const callbackKey = url.pathname.slice(4);
      const record = await env.BRIDGE_KV.get<CallbackRecord>(`callback:${callbackKey}`, "json");
      if (!record) return new Response("ok");

      const rawBytes = await req.arrayBuffer();
      const isClose = isJsonCloseEvent(new Uint8Array(rawBytes));

      if (record.platform === "telegram") {
        const stub = getAgentStub(env.TELEGRAM_AGENT, record);
        if (isClose) {
          const { code, reason } = parseCloseEvent(new Uint8Array(rawBytes));
          await stub.onSocketClosed(code, reason);
        } else {
          await stub.pushFrame(rawBytes);
        }
      } else {
        const stub = getAgentStub(env.ZALO_AGENT, record);
        if (isClose) {
          const { code, reason } = parseCloseEvent(new Uint8Array(rawBytes));
          await stub.onSocketClosed(code, reason);
        } else {
          await stub.pushFrame(rawBytes);
        }
      }
      return new Response("ok");
    }

    // 2. Agents SDK routing (WebSocket + HTTP for Agent DOs)
    const agentResponse = await routeAgentRequest(req, env);
    if (agentResponse) return agentResponse;

    // 3. Everything else → Next.js UI via vinext
    return handler.fetch(req);
  },
};
