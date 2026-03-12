import test from "node:test";
import assert from "node:assert/strict";
import bigInt from "big-integer";
import { Api } from "../worker/mtproto/serializer";
import {
  buildConversationCacheFromDialogs,
  buildInputPeerFromConversation,
} from "../worker/mtproto/inbound";
import {
  loadPendingRequests,
  resolvePendingRequest,
  trackPendingRequest,
} from "../worker/runtime-store";
import type { Env } from "../worker/types";

class MemoryKV {
  private store = new Map<string, string>();

  async get<T>(key: string, type?: "json"): Promise<T | string | null> {
    const value = this.store.get(key);
    if (value === undefined) {
      return null;
    }
    if (type === "json") {
      return JSON.parse(value) as T;
    }
    return value;
  }

  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

function fakeEnv(): Env {
  return {
    TG_KV: new MemoryKV() as unknown as KVNamespace,
  } as Env;
}

test("dialogs responses populate a conversation cache and rebuild input peers", () => {
  const dialogs = new Api.messages.Dialogs({
    dialogs: [
      new Api.Dialog({
        peer: new Api.PeerUser({ userId: bigInt(1) }),
        topMessage: 100,
        readInboxMaxId: 100,
        readOutboxMaxId: 100,
        unreadCount: 2,
        unreadMentionsCount: 0,
        unreadReactionsCount: 0,
        notifySettings: new Api.PeerNotifySettings({}),
        pts: 1,
      }),
      new Api.Dialog({
        peer: new Api.PeerChannel({ channelId: bigInt(2) }),
        topMessage: 200,
        readInboxMaxId: 200,
        readOutboxMaxId: 200,
        unreadCount: 0,
        unreadMentionsCount: 0,
        unreadReactionsCount: 0,
        notifySettings: new Api.PeerNotifySettings({}),
        pts: 1,
      }),
    ],
    messages: [],
    chats: [
      new Api.Channel({
        id: bigInt(2),
        accessHash: bigInt(22),
        title: "Announcements",
        photo: new Api.ChatPhotoEmpty(),
        date: 0,
      }),
    ],
    users: [
      new Api.User({
        id: bigInt(1),
        accessHash: bigInt(11),
        firstName: "Duy",
        username: "duy",
      }),
    ],
  });

  const cache = buildConversationCacheFromDialogs(dialogs);
  assert.ok(cache);
  assert.equal(cache?.items.length, 2);
  assert.deepEqual(cache?.items.map((item) => item.id), [
    "user:1",
    "channel:2",
  ]);

  const userPeer = buildInputPeerFromConversation(cache!.items[0]);
  const channelPeer = buildInputPeerFromConversation(cache!.items[1]);
  assert.equal(userPeer.className, "InputPeerUser");
  assert.equal(channelPeer.className, "InputPeerChannel");
});

test("dialogs cache accepts GramJS big-integer ids and access hashes", () => {
  const dialogs = {
    className: "messages.DialogsSlice",
    count: 1,
    dialogs: [
      {
        className: "Dialog",
        peer: {
          className: "PeerChannel",
          channelId: bigInt("1234567890"),
        },
        unreadCount: 7,
        topMessage: 42,
      },
    ],
    users: [],
    chats: [
      {
        className: "Channel",
        id: bigInt("1234567890"),
        accessHash: bigInt("9876543210"),
        title: "Release Notes",
        username: "releases",
      },
    ],
  };

  const cache = buildConversationCacheFromDialogs(dialogs);
  assert.deepEqual(cache, {
    items: [
      {
        id: "channel:1234567890",
        peerType: "channel",
        peerId: "1234567890",
        accessHash: "9876543210",
        title: "Release Notes",
        subtitle: "@releases",
        unreadCount: 7,
        topMessage: 42,
      },
    ],
    totalCount: 1,
    updatedAt: cache?.updatedAt,
  });
});

test("pending request tracking supports multiple concurrent requests", async () => {
  const env = fakeEnv();
  await trackPendingRequest(env, "session-1", "msg-1", {
    requestId: "req-1",
    kind: "dialogs",
    method: "messages.GetDialogs",
    createdAt: 1,
  });
  await trackPendingRequest(env, "session-1", "msg-2", {
    requestId: "req-2",
    kind: "send_message",
    method: "messages.SendMessage",
    createdAt: 2,
  });

  const before = await loadPendingRequests(env, "session-1");
  assert.deepEqual(Object.keys(before).sort(), ["msg-1", "msg-2"]);

  const first = await resolvePendingRequest(env, "session-1", "msg-1");
  const second = await resolvePendingRequest(env, "session-1", "msg-2");
  const after = await loadPendingRequests(env, "session-1");

  assert.equal(first?.requestId, "req-1");
  assert.equal(second?.requestId, "req-2");
  assert.deepEqual(after, {});
});
