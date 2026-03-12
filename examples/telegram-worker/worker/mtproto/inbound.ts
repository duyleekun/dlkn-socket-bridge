import bigInt from "big-integer";
import { MessageContainer, RPCResult } from "telegram/tl/core";
import { Api, deserializeTLResponse } from "./serializer";
import type {
  ConversationCache,
  ConversationOption,
  ConversationPeerType,
  ParsedPacketEntry,
} from "../types";

const DIALOG_LIMIT = 20;
const INTERNAL_FIELDS = new Set([
  "CONSTRUCTOR_ID",
  "SUBCLASS_OF_ID",
  "classType",
  "originalArgs",
]);

export interface ParsedRpcResult {
  reqMsgId: string;
  className: string;
  payload: unknown;
  raw: unknown;
}

export interface ParsedInboundBatch {
  entries: ParsedPacketEntry[];
  ackMsgIds: string[];
  rpcResults: ParsedRpcResult[];
}

function classNameOf(value: unknown): string | undefined {
  return (value as { className?: string } | null)?.className;
}

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export function normalizeTlValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
    return {
      type: "bytes",
      base64url: toBase64Url(value),
      length: value.length,
    };
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeTlValue(item));
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value !== "object") {
    return String(value);
  }

  const typed = value as Record<string, unknown>;
  const normalized: Record<string, unknown> = {};
  const className = classNameOf(value);
  if (className) {
    normalized.className = className;
  }

  for (const key of Object.keys(typed)) {
    if (INTERNAL_FIELDS.has(key)) {
      continue;
    }
    if (key === "flags" && typed[key] === undefined) {
      continue;
    }
    normalized[key] = normalizeTlValue(typed[key]);
  }

  return normalized;
}

function isAckOnlyServiceObject(value: unknown): boolean {
  const className = classNameOf(value);
  return className === "MsgsAck" || className === "NewSessionCreated";
}

async function parseRpcResult(result: RPCResult): Promise<ParsedRpcResult> {
  const reqMsgId = result.reqMsgId.toString();
  if (result.error) {
    return {
      reqMsgId,
      className: classNameOf(result.error) || "RpcError",
      payload: normalizeTlValue(result.error),
      raw: result.error,
    };
  }

  const raw = result.body === undefined
    ? undefined
    : result.body instanceof Uint8Array || Buffer.isBuffer(result.body)
      ? await deserializeTLResponse(new Uint8Array(result.body))
      : result.body;

  return {
    reqMsgId,
    className: classNameOf(raw) || "RpcResult",
    payload: normalizeTlValue(raw),
    raw,
  };
}

async function appendParsedObject(
  object: unknown,
  msgId: string,
  seqNo: number,
  receivedAt: number,
  entries: ParsedPacketEntry[],
  ackMsgIds: string[],
  rpcResults: ParsedRpcResult[],
): Promise<void> {
  if (object instanceof MessageContainer) {
    for (const message of object.messages) {
      await appendParsedObject(
        message.obj,
        message.msgId.toString(),
        message.seqNo,
        receivedAt,
        entries,
        ackMsgIds,
        rpcResults,
      );
    }
    return;
  }

  let className = classNameOf(object) || "Unknown";
  let payload = normalizeTlValue(object);
  let envelopeClassName: string | undefined;
  let reqMsgId: string | undefined;

  if (object instanceof RPCResult) {
    const parsed = await parseRpcResult(object);
    className = parsed.className;
    payload = parsed.payload;
    envelopeClassName = "RpcResult";
    reqMsgId = parsed.reqMsgId;
    rpcResults.push(parsed);
  }

  const requiresAck = seqNo % 2 === 1 && !isAckOnlyServiceObject(object);
  if (requiresAck) {
    ackMsgIds.push(msgId);
  }

  entries.push({
    id: `${msgId}:${entries.length}`,
    msgId,
    seqNo,
    receivedAt,
    requiresAck,
    className,
    envelopeClassName,
    reqMsgId,
    payload,
  });
}

export async function parseInboundObject(
  object: unknown,
  msgId: string,
  seqNo: number,
  receivedAt: number = Date.now(),
): Promise<ParsedInboundBatch> {
  const entries: ParsedPacketEntry[] = [];
  const ackMsgIds: string[] = [];
  const rpcResults: ParsedRpcResult[] = [];

  await appendParsedObject(
    object,
    msgId,
    seqNo,
    receivedAt,
    entries,
    ackMsgIds,
    rpcResults,
  );

  return { entries, ackMsgIds, rpcResults };
}

function makeConversationId(peerType: ConversationPeerType, peerId: string): string {
  return `${peerType}:${peerId}`;
}

function displayTitleFromUser(user: Record<string, unknown>): string {
  const firstName = typeof user.firstName === "string" ? user.firstName : "";
  const lastName = typeof user.lastName === "string" ? user.lastName : "";
  const fullName = `${firstName} ${lastName}`.trim();
  if (fullName) {
    return fullName;
  }
  if (typeof user.username === "string" && user.username) {
    return `@${user.username}`;
  }
  if (typeof user.phone === "string" && user.phone) {
    return `+${user.phone}`;
  }
  return `User ${String(user.id ?? "")}`.trim();
}

function subtitleFromEntity(entity: Record<string, unknown>): string | undefined {
  if (typeof entity.username === "string" && entity.username) {
    return `@${entity.username}`;
  }
  return undefined;
}

function entityId(value: unknown): string | undefined {
  if (bigInt.isInstance(value)) {
    return value.toString();
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "number") {
    return String(value);
  }
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value === "object" && "value" in value) {
    return entityId((value as { value?: unknown }).value);
  }
  return undefined;
}

export function buildConversationCacheFromDialogs(
  result: unknown,
): ConversationCache | null {
  const className = classNameOf(result);
  if (className !== "messages.Dialogs" && className !== "messages.DialogsSlice") {
    return null;
  }

  const typed = result as {
    dialogs?: Array<Record<string, unknown>>;
    users?: Array<Record<string, unknown>>;
    chats?: Array<Record<string, unknown>>;
    count?: number;
  };

  const usersById = new Map<string, Record<string, unknown>>();
  const chatsById = new Map<string, Record<string, unknown>>();

  for (const user of typed.users || []) {
    const id = entityId(user.id);
    if (id) {
      usersById.set(id, user);
    }
  }
  for (const chat of typed.chats || []) {
    const id = entityId(chat.id);
    if (id) {
      chatsById.set(id, chat);
    }
  }

  const items: ConversationOption[] = [];
  for (const dialog of typed.dialogs || []) {
    if (items.length >= DIALOG_LIMIT) {
      break;
    }
    const peer = dialog.peer as Record<string, unknown> | undefined;
    const peerClassName = classNameOf(peer);
    if (!peerClassName) {
      continue;
    }

    if (peerClassName === "PeerUser") {
      const peerId = entityId(peer?.userId);
      const user = peerId ? usersById.get(peerId) : undefined;
      if (!peerId || !user) {
        continue;
      }
      items.push({
        id: makeConversationId("user", peerId),
        peerType: "user",
        peerId,
        accessHash: entityId(user.accessHash),
        title: displayTitleFromUser(user),
        subtitle: subtitleFromEntity(user),
        unreadCount: typeof dialog.unreadCount === "number" ? dialog.unreadCount : undefined,
        topMessage: typeof dialog.topMessage === "number" ? dialog.topMessage : undefined,
      });
      continue;
    }

    if (peerClassName === "PeerChat") {
      const peerId = entityId(peer?.chatId);
      const chat = peerId ? chatsById.get(peerId) : undefined;
      if (!peerId || !chat) {
        continue;
      }
      items.push({
        id: makeConversationId("chat", peerId),
        peerType: "chat",
        peerId,
        title: typeof chat.title === "string" ? chat.title : `Chat ${peerId}`,
        unreadCount: typeof dialog.unreadCount === "number" ? dialog.unreadCount : undefined,
        topMessage: typeof dialog.topMessage === "number" ? dialog.topMessage : undefined,
      });
      continue;
    }

    if (peerClassName === "PeerChannel") {
      const peerId = entityId(peer?.channelId);
      const channel = peerId ? chatsById.get(peerId) : undefined;
      if (!peerId || !channel) {
        continue;
      }
      items.push({
        id: makeConversationId("channel", peerId),
        peerType: "channel",
        peerId,
        accessHash: entityId(channel.accessHash),
        title: typeof channel.title === "string" ? channel.title : `Channel ${peerId}`,
        subtitle: subtitleFromEntity(channel),
        unreadCount: typeof dialog.unreadCount === "number" ? dialog.unreadCount : undefined,
        topMessage: typeof dialog.topMessage === "number" ? dialog.topMessage : undefined,
      });
    }
  }

  return {
    items,
    updatedAt: Date.now(),
    totalCount: typeof typed.count === "number" ? typed.count : typed.dialogs?.length,
  };
}

export function buildInputPeerFromConversation(option: ConversationOption) {
  if (option.peerType === "user") {
    if (!option.accessHash) {
      throw new Error(`conversation ${option.id} is missing user access hash`);
    }
    return new Api.InputPeerUser({
      userId: BigInt(option.peerId),
      accessHash: BigInt(option.accessHash),
    });
  }

  if (option.peerType === "chat") {
    return new Api.InputPeerChat({
      chatId: Number(option.peerId),
    });
  }

  if (!option.accessHash) {
    throw new Error(`conversation ${option.id} is missing channel access hash`);
  }
  return new Api.InputPeerChannel({
    channelId: BigInt(option.peerId),
    accessHash: BigInt(option.accessHash),
  });
}
