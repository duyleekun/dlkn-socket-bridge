import test from "node:test";
import assert from "node:assert/strict";
import { resolveSelfThreadId } from "../worker/zalo-login";
import { mergeUserProfile } from "../worker/user-profile";

test("mergeUserProfile fills display fields from QR scan info without losing uid", () => {
  const merged = mergeUserProfile(
    {
      uid: "123456",
      displayName: "",
      avatar: "",
    },
    {
      displayName: "Nguyen Van A",
      avatar: "https://example.com/avatar.png",
    },
  );

  assert.deepEqual(merged, {
    uid: "123456",
    displayName: "Nguyen Van A",
    avatar: "https://example.com/avatar.png",
  });
});

test("mergeUserProfile keeps non-empty primary fields during persistence and restore", () => {
  const merged = mergeUserProfile(
    {
      uid: "123456",
      displayName: "Primary Name",
      avatar: "https://example.com/primary.png",
    },
    {
      displayName: "Fallback Name",
      avatar: "https://example.com/fallback.png",
    },
  );

  assert.deepEqual(merged, {
    uid: "123456",
    displayName: "Primary Name",
    avatar: "https://example.com/primary.png",
  });
});

test("resolveSelfThreadId reads the dedicated send-to-self thread from login info", () => {
  const threadId = resolveSelfThreadId({
    getContext() {
      return {
        loginInfo: {
          send2me_id: "  998877665544  ",
        },
      };
    },
    getCookie() {
      throw new Error("not used");
    },
    sendMessage() {
      throw new Error("not used");
    },
  });

  assert.equal(threadId, "998877665544");
});
