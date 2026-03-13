import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveAuthStep,
  describeRuntimeStage,
  getOutboundPanelState,
  isHealthySocket,
  isRemoteLogoutMessage,
  shouldShowRecoveryBanner,
} from "../app/zalo/status";

test("deriveAuthStep keeps ws_connecting distinct from listening", () => {
  assert.equal(
    deriveAuthStep({
      phase: "ws_connecting",
      view: { hasQrCode: false },
    }),
    "socket_connecting",
  );

  assert.equal(
    deriveAuthStep({
      phase: "listening",
      view: { hasQrCode: false },
    }),
    "listening",
  );
});

test("deriveAuthStep maps QR and restored states to UI-facing steps", () => {
  assert.equal(
    deriveAuthStep({
      phase: "qr_awaiting_scan",
      view: { hasQrCode: true },
    }),
    "qr_ready",
  );

  assert.equal(
    deriveAuthStep({
      phase: "qr_scanned",
      view: { hasQrCode: true },
    }),
    "qr_scanned",
  );
});

test("describeRuntimeStage distinguishes restoring from live listening", () => {
  assert.deepEqual(describeRuntimeStage(true, "socket_connecting"), {
    label: "Restoring session",
    detail: "Checking for a saved session and bridge socket before showing login.",
  });

  assert.deepEqual(describeRuntimeStage(false, "listening"), {
    label: "Listening",
    detail: "Bridge callbacks are flowing and the session is ready to receive realtime messages.",
  });
});

test("describeRuntimeStage surfaces remote logout as a re-login prompt", () => {
  assert.equal(
    isRemoteLogoutMessage("Zalo session ended remotely. Scan a new QR code to sign back in."),
    true,
  );

  assert.deepEqual(
    describeRuntimeStage(
      false,
      "error",
      "Zalo session ended remotely. Scan a new QR code to sign back in.",
    ),
    {
      label: "Signed out remotely",
      detail: "This Zalo session was ended from another device. Start a fresh QR login to continue.",
    },
  );
});

test("recovery banner visibility matches unhealthy bridge states", () => {
  assert.equal(shouldShowRecoveryBanner("healthy"), false);
  assert.equal(shouldShowRecoveryBanner("unknown"), false);
  assert.equal(shouldShowRecoveryBanner(undefined), false);
  assert.equal(shouldShowRecoveryBanner("stale"), true);
  assert.equal(shouldShowRecoveryBanner("closed"), true);
  assert.equal(shouldShowRecoveryBanner("error"), true);
  assert.equal(
    shouldShowRecoveryBanner(
      "closed",
      "Zalo session ended remotely. Scan a new QR code to sign back in.",
    ),
    false,
  );
});

test("socket health helper keeps unknown sockets non-alarming during bootstrap", () => {
  assert.equal(isHealthySocket("healthy"), true);
  assert.equal(isHealthySocket("unknown"), true);
  assert.equal(isHealthySocket(undefined), true);
  assert.equal(isHealthySocket("closed"), false);
  assert.equal(isHealthySocket("stale"), false);
});

test("outbound panel only renders as disabled once listening", () => {
  assert.equal(getOutboundPanelState("configure"), "hidden");
  assert.equal(getOutboundPanelState("qr_ready"), "hidden");
  assert.equal(getOutboundPanelState("socket_connecting"), "hidden");
  assert.equal(getOutboundPanelState("listening"), "disabled");
});
