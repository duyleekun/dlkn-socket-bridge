/**
 * Cloudflare Worker entry point for telegram-worker.
 *
 * Routes:
 *   POST /cb/:sessionKey — Bridge callback (binary data or close event)
 *   Everything else       → vinext (React UI + Server Actions)
 */

import handler from "vinext/server/app-router-entry";
import { onResponse } from "./state-machine";
import { markSocketState } from "./socket-health";
import type { Env, SessionState } from "./types";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // ─── Bridge callback — the only non-vinext route ───
    if (request.method === "POST" && url.pathname.startsWith("/cb/")) {
      const sessionKey = url.pathname.slice(4); // strip "/cb/"
      const rawBody = new Uint8Array(await request.arrayBuffer());

      // Check if it's a JSON close event
      try {
        const text = new TextDecoder().decode(rawBody);
        const json = JSON.parse(text) as { event?: string; reason?: string };
        if (json.event === "closed") {
          const state = await env.TG_KV.get<SessionState>(
            `session:${sessionKey}`,
            "json",
          );
          if (state) {
            await markSocketState(
              env,
              sessionKey,
              "closed",
              `connection closed: ${json.reason || "unknown"}`,
            );
          }
          return new Response("ok");
        }
      } catch {
        // Not JSON — it's binary data, pass through to state machine
      }

      await onResponse(env, url.origin, sessionKey, rawBody);
      return new Response("ok");
    }

    // ─── Everything else → vinext (pages + server actions) ───
    return handler.fetch(request);
  },
};
