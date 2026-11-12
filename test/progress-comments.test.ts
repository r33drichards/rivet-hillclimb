import { test } from "node:test";
import assert from "node:assert/strict";
import { enqueueProgress, deliverProgress, type ProgressState } from "../src/progress-comments.js";
import type { ProgressComment } from "../src/hooks/forward-comment.js";
import type { HillclimbJob } from "../src/github.js";
const job: HillclimbJob = { owner: "r33drichards", repo: "test", number: 1, installationId: 1, deliveryId: "label", headSha: "head" };
const event = (n: number, mode: "append" | "update" = "update"): ProgressComment => ({ id: n.toString(16).padStart(64, "0"), event: "beforeTool", body: `event ${n}`, mode });
test("rolling progress coalesces rapid updates and ignores retried older events", async () => {
  const state: ProgressState = {};
  assert.equal(enqueueProgress(state, event(1)), true);
  assert.equal(enqueueProgress(state, event(2)), true);
  assert.equal(enqueueProgress(state, event(1)), false);
  assert.deepEqual(state.progressQueue?.map(e => e.body), ["event 2"]);
  const writes: string[] = [];
  await deliverProgress(state, job, async (_job, body, key) => { writes.push(key!); assert.match(body, /event 2/); });
  assert.deepEqual(writes, ["progress"]);
  assert.equal(enqueueProgress(state, event(2)), false);
  assert.equal(state.progressQueue?.length, 0);
});
test("append events retain stable per-event comment markers through failed delivery", async () => {
  const state: ProgressState = {};
  enqueueProgress(state, event(1, "append")); enqueueProgress(state, event(2, "append"));
  await assert.rejects(deliverProgress(state, job, async () => { throw Error("GitHub unavailable"); }));
  assert.equal(state.progressQueue?.length, 2);
  const keys: string[] = [];
  const post = async (_job: HillclimbJob, _body: string, key?: string) => { keys.push(key!); };
  await deliverProgress(state, job, post); await deliverProgress(state, job, post);
  assert.deepEqual(keys, [`progress-${event(1).id}`, `progress-${event(2).id}`]);
});
test("a newer update arriving during GitHub delivery is retained", async () => {
  const state: ProgressState = {};
  enqueueProgress(state, event(1));
  await deliverProgress(state, job, async () => { enqueueProgress(state, event(2)); });
  assert.deepEqual(state.progressQueue?.map(e => e.id), [event(2).id]);
});
