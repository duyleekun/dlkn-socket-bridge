import test from "node:test";
import assert from "node:assert/strict";
import {
  createSessionRuntimeAdapter,
  createSessionTransitionResult,
  supportsSocketClose,
  withRuntimeView,
} from "../src/index.js";

test("createSessionTransitionResult keeps payload and view intact", () => {
  const result = createSessionTransitionResult(
    { id: 1 },
    ["send"],
    ["event"],
    { phase: "ready" },
  );

  assert.deepEqual(result, {
    snapshot: { id: 1 },
    commands: ["send"],
    events: ["event"],
    view: { phase: "ready" },
  });
});

test("withRuntimeView derives the view from the snapshot", () => {
  const result = withRuntimeView(
    {
      snapshot: { phase: "idle" },
      commands: [],
      events: [],
    },
    (snapshot) => ({ summary: snapshot.phase }),
  );

  assert.deepEqual(result.view, { summary: "idle" });
});

test("createSessionRuntimeAdapter exposes the inbound-frame builder", () => {
  const adapter = createSessionRuntimeAdapter({
    async createSession() {
      return createSessionTransitionResult("snapshot", [], [], "view");
    },
    async transitionSession() {
      return createSessionTransitionResult("snapshot", [], [], "view");
    },
    selectView: () => "view",
    getStateValue: () => "idle",
    buildInboundFrameEvent: (frame) => ({ type: "inbound", frame }),
  });

  const frame = Uint8Array.from([1, 2, 3]);

  assert.deepEqual(adapter.buildInboundFrameEvent(frame), {
    type: "inbound",
    frame,
  });
});

test("createSessionRuntimeAdapter records socket-close capability", async () => {
  const adapterWithoutClose = createSessionRuntimeAdapter({
    async createSession() {
      return createSessionTransitionResult("snapshot", [], [], "view");
    },
    async transitionSession() {
      return createSessionTransitionResult("snapshot", [], [], "view");
    },
    selectView: () => "view",
    getStateValue: () => "idle",
    buildInboundFrameEvent: () => ({ type: "inbound" }),
  });

  const adapterWithClose = createSessionRuntimeAdapter({
    async createSession() {
      return createSessionTransitionResult("snapshot", [], [], "view");
    },
    async transitionSession() {
      return createSessionTransitionResult("snapshot", [], [], "view");
    },
    selectView: () => "view",
    getStateValue: () => "idle",
    buildInboundFrameEvent: () => ({ type: "inbound" }),
    buildSocketClosedEvent: (code, reason) => ({ type: "closed", code, reason }),
  });

  assert.equal(supportsSocketClose(adapterWithoutClose), false);
  assert.equal(supportsSocketClose(adapterWithClose), true);
  assert.equal(adapterWithoutClose.buildSocketClosedEvent, undefined);
  assert.deepEqual(adapterWithClose.buildSocketClosedEvent?.(1000, "done"), {
    type: "closed",
    code: 1000,
    reason: "done",
  });
});

test("createSessionRuntimeAdapter preserves nullable socket-close handlers", () => {
  const adapter = createSessionRuntimeAdapter({
    async createSession() {
      return createSessionTransitionResult("snapshot", [], [], "view");
    },
    async transitionSession() {
      return createSessionTransitionResult("snapshot", [], [], "view");
    },
    selectView: () => "view",
    getStateValue: () => "idle",
    buildInboundFrameEvent: () => ({ type: "inbound" }),
    buildSocketClosedEvent: () => null,
  });

  assert.equal(supportsSocketClose(adapter), true);
  assert.equal(adapter.buildSocketClosedEvent?.(1000, "done"), null);
});
