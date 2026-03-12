import test from "node:test";
import assert from "node:assert/strict";
import bigInt from "big-integer";
import { MessageContainer, RPCResult, TLMessage } from "telegram/tl/core";
import { Api, serializeTLObject } from "../worker/mtproto/serializer";
import {
  buildConversationCacheFromDialogs,
  buildInputPeerFromConversation,
  parseInboundObject,
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

test("rpc results are normalized and correlated by reqMsgId", async () => {
  const rpc = new RPCResult(
    999n,
    serializeTLObject(new Api.Pong({ msgId: 10n, pingId: 20n })),
    undefined,
  );

  const parsed = await parseInboundObject(rpc, "1234", 1, 111);
  assert.equal(parsed.entries.length, 1);
  assert.deepEqual(parsed.ackMsgIds, ["1234"]);
  assert.equal(parsed.rpcResults.length, 1);
  assert.equal(parsed.rpcResults[0].reqMsgId, "999");
  assert.equal(parsed.entries[0].className, "Pong");
  assert.equal(parsed.entries[0].reqMsgId, "999");
});

test("message containers are flattened and ack-only service objects are skipped", async () => {
  const container = new MessageContainer([
    new TLMessage(11n, 1, new Api.MsgsAck({ msgIds: [1n] })),
    new TLMessage(12n, 1, new Api.NewSessionCreated({
      firstMsgId: 1n,
      uniqueId: 2n,
      serverSalt: 3n,
    })),
    new TLMessage(13n, 1, new Api.Pong({ msgId: 3n, pingId: 4n })),
  ]);

  const parsed = await parseInboundObject(container, "9999", 1, 222);
  assert.equal(parsed.entries.length, 3);
  assert.deepEqual(parsed.ackMsgIds, ["13"]);
  assert.equal(parsed.entries[2].className, "Pong");
});

test("dialogs responses populate a conversation cache and rebuild input peers", () => {
  const dialogs = new Api.messages.Dialogs({
    dialogs: [
      new Api.Dialog({
        peer: new Api.PeerUser({ userId: 1n }),
        topMessage: 100,
        readInboxMaxId: 100,
        readOutboxMaxId: 100,
        unreadCount: 2,
        unreadMentionsCount: 0,
        unreadReactionsCount: 0,
        notifySettings: new Api.PeerNotifySettings(),
        pts: 1,
      }),
      new Api.Dialog({
        peer: new Api.PeerChannel({ channelId: 2n }),
        topMessage: 200,
        readInboxMaxId: 200,
        readOutboxMaxId: 200,
        unreadCount: 0,
        unreadMentionsCount: 0,
        unreadReactionsCount: 0,
        notifySettings: new Api.PeerNotifySettings(),
        pts: 1,
      }),
    ],
    messages: [],
    chats: [
      new Api.Channel({
        id: 2n,
        accessHash: 22n,
        title: "Announcements",
        photo: new Api.ChatPhotoEmpty(),
        date: 0,
      }),
    ],
    users: [
      new Api.User({
        id: 1n,
        accessHash: 11n,
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
