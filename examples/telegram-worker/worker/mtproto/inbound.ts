/**
 * inbound.ts — PARTIALLY RETAINED
 *
 * All generic inbound parsing (parseInboundObject, parseRpcResult,
 * normalizeTlValue) has been removed in favour of the gramjs-statemachine
 * library's built-in dispatch layer.
 *
 * Retained:
 *   - buildConversationCacheFromDialogs() — used by action-handler.ts
 *   - buildInputPeerFromConversation()    — used by server actions
 */

import bigInt from "big-integer";
import { Api } from "./serializer";
import type {
  ConversationCache,
  ConversationOption,
  ConversationPeerType,
} from "../types";

// Re-export normalizeTlValue from gramjs-statemachine so any existing import
// site still resolves.
export { normalizeTlValue } from "gramjs-statemachine";

const DIALOG_LIMIT = 20;

function classNameOf(value: unknown): string | undefined {
  return (value as { className?: string } | null)?.className;
}

function makeConversationId(peerType: ConversationPeerType, peerId: string): string {
  return `${peerType}:${peerId}`;
}

function displayTitleFromUser(user: Record<string, unknown>): string {
  const firstName = typeof user.firstName === "string" ? user.firstName : "";
  const lastName = typeof user.lastName === "string" ? user.lastName : "";
  const fullName = `${firstName} ${lastName}`.trim();
  if (fullName) return fullName;
  if (typeof user.username === "string" && user.username) return `@${user.username}`;
  if (typeof user.phone === "string" && user.phone) return `+${user.phone}`;
  return `User ${String(user.id ?? "")}`.trim();
}

function subtitleFromEntity(entity: Record<string, unknown>): string | undefined {
  if (typeof entity.username === "string" && entity.username) {
    return `@${entity.username}`;
  }
  return undefined;
}

function entityId(value: unknown): string | undefined {
  if (bigInt.isInstance(value)) return value.toString();
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value;
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
    if (id) usersById.set(id, user);
  }
  for (const chat of typed.chats || []) {
    const id = entityId(chat.id);
    if (id) chatsById.set(id, chat);
  }

  const items: ConversationOption[] = [];
  for (const dialog of typed.dialogs || []) {
    if (items.length >= DIALOG_LIMIT) break;
    const peer = dialog.peer as Record<string, unknown> | undefined;
    const peerClassName = classNameOf(peer);
    if (!peerClassName) continue;

    if (peerClassName === "PeerUser") {
      const peerId = entityId(peer?.userId);
      const user = peerId ? usersById.get(peerId) : undefined;
      if (!peerId || !user) continue;
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
      if (!peerId || !chat) continue;
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
      if (!peerId || !channel) continue;
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
      userId: bigInt(option.peerId),
      accessHash: bigInt(option.accessHash),
    });
  }

  if (option.peerType === "chat") {
    return new Api.InputPeerChat({
      chatId: bigInt(option.peerId),
    });
  }

  if (!option.accessHash) {
    throw new Error(`conversation ${option.id} is missing channel access hash`);
  }
  return new Api.InputPeerChannel({
    channelId: bigInt(option.peerId),
    accessHash: bigInt(option.accessHash),
  });
}
