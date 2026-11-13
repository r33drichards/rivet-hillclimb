import { test } from "node:test";
import assert from "node:assert/strict";
import { restoreCiWait, recordCiWait, copyWaitIntent, type WaitIntent } from "../src/wait-intent.js";

test("wait intent is detached before the transaction overlay closes", () => {
  const overlay = Proxy.revocable({ runId: "run", id: "run:call", head: "head" }, {});
  const intent = copyWaitIntent(overlay.proxy);
  overlay.revoke();
  assert.throws(() => overlay.proxy.head);
  const state = { status: "running", waitingHead: null as string | null };
  assert.equal(restoreCiWait(state, "run", intent), true);
  assert.equal(state.waitingHead, "head");
  assert.equal(copyWaitIntent(null), null);
});

test("terminal recovery restores a durable tool wait and replays its receipt idempotently", () => {
  const state = { status: "running", waitingHead: null as string | null, appliedWaitIntent: null as string | null };
  const intent = { runId: "delivery-1", id: "delivery-1:call-2", head: "new-head" };
  assert.equal(restoreCiWait(state, "delivery-1", intent), true);
  assert.deepEqual(state, { status: "waiting_ci", waitingHead: "new-head", appliedWaitIntent: intent.id });
  assert.equal(restoreCiWait(state, "delivery-1", intent), true, "coordinator notification may be retried after a crash");
  assert.equal(state.waitingHead, "new-head");
});
test("old runs cannot restore stale heads into a newer submission", () => {
  const state = { status: "running", waitingHead: "current-head", appliedWaitIntent: "new:call" };
  assert.equal(restoreCiWait(state, "new", { runId: "old", id: "old:call", head: "old-head" }), false);
  assert.equal(state.waitingHead, "current-head");
  assert.equal(state.status, "running");
});
test("cancellation ignores a durable wait; legacy wait state survives absent intents", () => {
  const cancelled = { status: "cancelled", waitingHead: null };
  assert.equal(restoreCiWait(cancelled, "run", { runId: "run", id: "call", head: "head" }), false);
  assert.deepEqual(cancelled, { status: "cancelled", waitingHead: null });
  const legacy = { status: "waiting_ci", waitingHead: "legacy-head" };
  assert.equal(restoreCiWait(legacy, "run", null), false);
  assert.equal(legacy.waitingHead, "legacy-head");
});

test("tool commit records one stable identity; a delayed old invocation cannot overwrite a new run", () => {
  const doc = { runId: "first", request: null as WaitIntent | null };
  recordCiWait(doc, "first", "call", "first-head");
  const saved = structuredClone(doc);
  recordCiWait(doc, "first", "call", "first-head");
  assert.deepEqual(doc, saved);
  doc.runId = "second"; doc.request = null;
  assert.throws(() => recordCiWait(doc, "first", "call", "old-head"), /run changed/);
  assert.equal(doc.request, null);
  recordCiWait(doc, "second", "call", "second-head");
  assert.equal(doc.request!.id, "second:call");
});
