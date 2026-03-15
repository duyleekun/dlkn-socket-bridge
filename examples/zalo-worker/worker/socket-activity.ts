import {
  decodeWsFrame,
  extractSocketMessages,
  getZaloWsCmdName,
  parseSocketFrame,
  type SessionSnapshot,
  type SocketParsedEvent,
  ZALO_WS_CMD,
  ZALO_WS_SUB_CMD,
} from "zca-js-statemachine";
import type { SocketActivityEntry } from "./types";

interface ActivityContext {
  bytes: number;
  cmd?: number;
  subCmd?: number;
  direction: "rx" | "tx";
  timestamp: number;
}

function createActivityEntry(
  input: Omit<SocketActivityEntry, "id">,
): SocketActivityEntry {
  return {
    id: crypto.randomUUID(),
    ...input,
  };
}

function truncate(value: string, max = 280): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function stringifyDetail(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? truncate(trimmed) : undefined;
  }
  try {
    return truncate(JSON.stringify(value));
  } catch {
    return undefined;
  }
}

function summarizeInboundFrame(cmd: number): string {
  if (cmd === ZALO_WS_CMD.USER_MESSAGE || cmd === ZALO_WS_CMD.GROUP_MESSAGE) {
    return "Inbound message frame";
  }
  if (cmd === ZALO_WS_CMD.GET_MSG_1_1 || cmd === ZALO_WS_CMD.GET_MSG_GROUP) {
    return "Inbound recovery frame";
  }
  if (
    cmd === ZALO_WS_CMD.REACTION_EVENT ||
    cmd === ZALO_WS_CMD.CTRL_PULL_REACT ||
    cmd === ZALO_WS_CMD.CTRL_PULL_REACT_BIG_GR
  ) {
    return "Inbound reaction frame";
  }
  if (cmd === ZALO_WS_CMD.CONTROL_EVENT) {
    return "Inbound control frame";
  }
  if (cmd === ZALO_WS_CMD.TYPING_EVENT) {
    return "Inbound typing frame";
  }
  const cmdName = getZaloWsCmdName(cmd);
  return cmdName ? `Inbound ${cmdName} frame` : "Inbound frame";
}

function describeParsedEvent(
  event: SocketParsedEvent,
  context: ActivityContext,
): SocketActivityEntry {
  switch (event.type) {
    case "frame": {
      const messages = extractSocketMessages(event);
      const firstMessage = messages[0];
      const summary = firstMessage
        ? firstMessage.content || "(empty message payload)"
        : summarizeInboundFrame(event.cmd);
      const metadata = firstMessage
        ? `id=${firstMessage.id} from=${firstMessage.fromId || "unknown"} type=${firstMessage.isGroup ? 1 : 0}${firstMessage.msgType ? ` msgType=${firstMessage.msgType}` : ""}`
        : undefined;
      const serializedData = stringifyDetail(event.data);
      const details =
        messages.length > 1
          ? [`count=${messages.length}`, metadata, serializedData].filter(Boolean).join("\n")
          : [metadata, serializedData].filter(Boolean).join("\n") || undefined;

      return createActivityEntry({
        direction: context.direction,
        timestamp: context.timestamp,
        type: "frame",
        summary,
        details,
        cmd: event.cmd,
        subCmd: event.subCmd,
        bytes: context.bytes,
        recovered: firstMessage?.recovered,
        payloadKind: event.payloadKind,
      });
    }

    case "cipher_key":
      return createActivityEntry({
        direction: context.direction,
        timestamp: context.timestamp,
        type: "cipher_key",
        summary: "Cipher key handshake",
        details: "Socket encryption key received.",
        cmd: context.cmd,
        subCmd: context.subCmd,
        bytes: context.bytes,
      });

    case "duplicate_connection":
      return createActivityEntry({
        direction: context.direction,
        timestamp: context.timestamp,
        type: "duplicate_connection",
        summary: "Duplicate connection event",
        details: "Zalo reported another active socket for this session.",
        cmd: context.cmd,
        subCmd: context.subCmd,
        bytes: context.bytes,
      });
  }
}

function describeOutboundFrame(bytes: Uint8Array): SocketActivityEntry {
  const timestamp = Date.now();
  try {
    const decoded = decodeWsFrame(bytes);
    let summary = "Unknown outbound packet";
    let details = stringifyDetail(decoded.payload);
    let type = "unknown";

    if (decoded.cmd === ZALO_WS_CMD.PING && decoded.subCmd === ZALO_WS_SUB_CMD.PING) {
      type = "ping";
      summary = "Ping frame";
      details = "Bridge keepalive sent to Zalo realtime socket.";
    } else if (
      (decoded.cmd === ZALO_WS_CMD.GET_MSG_1_1 || decoded.cmd === ZALO_WS_CMD.GET_MSG_GROUP) &&
      decoded.subCmd === ZALO_WS_SUB_CMD.QUEUE_PULL
    ) {
      type = "request_old_messages";
      const payload = JSON.parse(decoded.payload) as { lastId?: string | null };
      const threadType = decoded.cmd === ZALO_WS_CMD.GET_MSG_GROUP ? "group" : "user";
      summary = `Old message recovery request (${threadType})`;
      details = payload.lastId
        ? `thread=${threadType} lastId=${payload.lastId}`
        : `thread=${threadType}`;
    }

    return createActivityEntry({
      direction: "tx",
      timestamp,
      type,
      summary,
      details,
      cmd: decoded.cmd,
      subCmd: decoded.subCmd,
      bytes: bytes.length,
    });
  } catch (error) {
    return createActivityEntry({
      direction: "tx",
      timestamp,
      type: "unknown",
      summary: "Unknown outbound packet",
      details: error instanceof Error ? error.message : String(error),
      bytes: bytes.length,
    });
  }
}

export function describeTxFrame(bytes: Uint8Array): SocketActivityEntry {
  return describeOutboundFrame(bytes);
}

export async function describeRxFrame(
  snapshot: SessionSnapshot,
  bytes: Uint8Array,
): Promise<SocketActivityEntry[]> {
  const timestamp = Date.now();

  try {
    const decoded = decodeWsFrame(bytes);
    const events = await parseSocketFrame(bytes, {
      cipherKey: snapshot.context.cipherKey ?? undefined,
    });

    if (events.length > 0) {
      return events.map((event) =>
        describeParsedEvent(event, {
          direction: "rx",
          timestamp,
          cmd: decoded.cmd,
          subCmd: decoded.subCmd,
          bytes: bytes.length,
        }),
      );
    }

    if (decoded.cmd === ZALO_WS_CMD.PING) {
      return [
        createActivityEntry({
          direction: "rx",
          timestamp,
          type: "ping",
          summary: "Ping frame",
          details: "Socket keepalive received from Zalo realtime socket.",
          cmd: decoded.cmd,
          subCmd: decoded.subCmd,
          bytes: bytes.length,
        }),
      ];
    }

    return [
      createActivityEntry({
        direction: "rx",
        timestamp,
        type: "frame",
        summary: summarizeInboundFrame(decoded.cmd),
        details: stringifyDetail(decoded.payload),
        cmd: decoded.cmd,
        subCmd: decoded.subCmd,
        bytes: bytes.length,
        payloadKind: "raw",
      }),
    ];
  } catch (error) {
    return [
      createActivityEntry({
        direction: "rx",
        timestamp,
        type: "unknown",
        summary: "Unknown inbound packet",
        details: error instanceof Error ? error.message : String(error),
        bytes: bytes.length,
      }),
    ];
  }
}
