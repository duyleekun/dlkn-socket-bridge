import { DurableObject } from "cloudflare:workers";

interface ControlSocketAttachment {
  type: "control";
  bridgeId: string;
}

export class DurableSocket extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Protocol-level ping/pong — no DO wake needed
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong")
    );
    // Init SQL schema for session routing
    this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS ds_sessions (
          socket_key    TEXT PRIMARY KEY,
          platform      TEXT NOT NULL,
          instance_id   TEXT NOT NULL,
          instance_name TEXT
        )
      `);
    });
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("WebSocket upgrade required", { status: 426 });
    }
    const url = new URL(request.url);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

    if (url.pathname === "/ds/control") {
      server.serializeAttachment({ type: "control", bridgeId: "" } satisfies ControlSocketAttachment);
      this.ctx.acceptWebSocket(server, ["control"]);
      console.log("[DurableSocket] control WS accepted");
    } else {
      return new Response("Not found", { status: 404 });
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;
    let msg: { type: string; bridge_id?: string; socket_key?: string; reason?: string };
    try {
      msg = JSON.parse(message) as typeof msg;
    } catch {
      console.warn("[DurableSocket] invalid JSON from bridge:", message);
      return;
    }

    if (msg.type === "register" && msg.bridge_id) {
      ws.serializeAttachment({ type: "control", bridgeId: msg.bridge_id } satisfies ControlSocketAttachment);
      console.log("[DurableSocket] bridge registered:", msg.bridge_id);
    } else if (msg.type === "session_closed" && msg.socket_key) {
      console.log("[DurableSocket] session_closed:", msg.socket_key, "reason:", msg.reason);
      const rows = this.ctx.storage.sql
        .exec<{ platform: string; instance_id: string; instance_name: string | null }>(
          `SELECT platform, instance_id, instance_name FROM ds_sessions WHERE socket_key = ?`,
          msg.socket_key
        ).toArray();
      const row = rows[0];
      if (row) {
        try {
          const stub = this.#agentStub(row.platform, row.instance_id, row.instance_name);
          await stub.onSocketClosed(1006, msg.reason ?? "bridge_closed");
        } catch (err) {
          console.error("[DurableSocket] failed to notify agent of session_closed:", err);
        }
        this.ctx.storage.sql.exec(
          `DELETE FROM ds_sessions WHERE socket_key = ?`,
          msg.socket_key
        );
      }
    } else if (msg.type === "pong") {
      // Acknowledged
    } else {
      console.warn("[DurableSocket] unknown message type:", msg.type);
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    const att = ws.deserializeAttachment() as ControlSocketAttachment | null;
    console.log("[DurableSocket] bridge control WS closed, bridgeId:", att?.bridgeId, "code:", code, "reason:", reason);
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    const att = ws.deserializeAttachment() as ControlSocketAttachment | null;
    console.error("[DurableSocket] bridge control WS error, bridgeId:", att?.bridgeId, error);
  }

  // RPC called by Agent DO to request a bridge open a target connection
  async createSession(
    socketKey: string,
    targetUrl: string,
    agentDataWsUrl: string,
    platform: string,
    instanceId: string,
    instanceName: string | null,
    headers?: Record<string, string>,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const bridges = this.ctx.getWebSockets("control");
    if (bridges.length === 0) {
      console.warn("[DurableSocket] createSession: no bridges available");
      return { ok: false, error: "No bridges available" };
    }
    // Pick first available bridge (simple strategy)
    const bridge = bridges[Math.floor(Math.random() * bridges.length)];

    // Persist for session_closed routing
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO ds_sessions (socket_key, platform, instance_id, instance_name) VALUES (?, ?, ?, ?)`,
      socketKey, platform, instanceId, instanceName
    );

    bridge.send(JSON.stringify({
      type: "open_session",
      socket_key: socketKey,
      target_url: targetUrl,
      data_ws_url: agentDataWsUrl,
      ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
    }));

    console.log("[DurableSocket] createSession: sent open_session to bridge, socketKey:", socketKey);
    return { ok: true };
  }

  #agentStub(platform: string, instanceId: string, instanceName: string | null): {
    onSocketClosed(code: number, reason: string): Promise<void>;
  } {
    const ns = platform === "telegram" ? this.env.TELEGRAM_AGENT : this.env.ZALO_AGENT;
    const id = instanceName ? ns.idFromName(instanceName) : ns.idFromString(instanceId);
    return ns.get(id) as unknown as { onSocketClosed(code: number, reason: string): Promise<void> };
  }
}
