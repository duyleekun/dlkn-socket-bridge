/**
 * Cloudflare Worker entry point for telegram-worker.
 *
 * Routes:
 *   POST /cb/:callbackKey — Bridge callback (binary data or close event)
 *   Everything else       → vinext (React UI + Server Actions)
 */

import handler from "vinext/server/app-router-entry";
import { onCallback } from "./adapter/on-callback";
import {
  loadSessionKeyByCallbackKey,
  loadBridgeSession,
} from "./session-store";
import { markSocketState } from "./socket-health";
import type { Env } from "./types";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // ─── Bridge callback — the only non-vinext route ───
    if (request.method === "POST" && url.pathname.startsWith("/cb/")) {
      const callbackKey = url.pathname.slice(4); // strip "/cb/"
      const sessionKey = await loadSessionKeyByCallbackKey(env, callbackKey);
      if (!sessionKey) {
        return new Response("ok");
      }

      const bridge = await loadBridgeSession(env, sessionKey);
      if (!bridge || bridge.callbackKey !== callbackKey) {
        return new Response("ok");
      }

      const rawBody = new Uint8Array(await request.arrayBuffer());

      // Check if it's a JSON close event
      try {
        const text = new TextDecoder().decode(rawBody);
        const json = JSON.parse(text) as { event?: string; reason?: string };
        if (json.event === "closed") {
          await markSocketState(
            env,
            sessionKey,
            "closed",
            `connection closed: ${json.reason || "unknown"}`,
          );
          return new Response("ok");
        }
      } catch {
        // Not JSON — it's binary data, pass through to state machine
      }

      await onCallback(env, url.origin, sessionKey, rawBody);
      return new Response("ok");
    }

    // ─── Everything else → vinext (pages + server actions) ───
    return handler.fetch(request);
  },
};
