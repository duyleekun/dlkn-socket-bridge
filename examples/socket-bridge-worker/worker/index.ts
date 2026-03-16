/**
 * socket-bridge-worker — unified Worker entry point.
 *
 * Routes:
 *   WS  /ds/control        → DurableSocket DO (bridge control WebSocket)
 *   GET|POST /agents/**    → routeAgentRequest (WebSocket + HTTP)
 *   Everything else        → vinext (Next.js UI)
 */

import handler from "vinext/server/app-router-entry";
import { routeAgentRequest } from "agents";
import { TelegramAgent } from "../agents/telegram-agent";
import { ZaloAgent } from "../agents/zalo-agent";
import { DurableSocket } from "../agents/durable-socket";
export { TelegramAgent, ZaloAgent, DurableSocket };

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // 1. Bridge control WebSocket → DurableSocket DO
    if (req.headers.get("Upgrade") === "websocket" && url.pathname === "/ds/control") {
      const stub = env.DURABLE_SOCKET.get(env.DURABLE_SOCKET.idFromName("default"));
      return stub.fetch(req);
    }

    // 2. Agents SDK routing (WebSocket + HTTP for Agent DOs)
    const agentResponse = await routeAgentRequest(req, env);
    if (agentResponse) return agentResponse;

    // 3. Everything else → Next.js UI via vinext
    return handler.fetch(req);
  },
};
