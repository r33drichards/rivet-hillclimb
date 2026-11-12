import { test } from "node:test";
import assert from "node:assert/strict";
import type { SubmissionId } from "@earendil-works/pi-durable";
import { isTransportFailure, readTurnResult, type TurnReader } from "../src/turn-submission.js";
const id = 33 as SubmissionId;
function reader(receipt: any, messages: any[] = []) {
  const reads: unknown[] = [];
  const client: TurnReader = {
    submission: { status: async value => { reads.push(["receipt", value]); return receipt; } },
    conversation: { entries: async (...args) => { reads.push(["history", ...args]); return { items: messages }; } },
  };
  return { client, reads };
}
test("a submission still running after HTTP's five-minute timeout remains pending, without waiting or submitting again", async () => {
  const { client, reads } = reader({ id, status: "placed", conversationId: 1, requestId: "original-webhook", entry: 32, startedAt: Date.now() - 600_000 });
  assert.deepEqual(await readTurnResult(client, id), { status: "pending" });
  assert.deepEqual(reads, [["receipt", id]], "no blocking wait, inference request, or history read for an active submission");
});
test("completed submission reads its exact persisted answer without another prompt", async () => {
  const { client, reads } = reader({ id, type: "input", status: "done", conversationId: 1, answer: 55 }, [{ model: [{ role: "assistant", content: [{ type: "text", text: "Finished. " }, { type: "thinking", thinking: "private" }, { type: "text", text: "CI passed." }] }] }]);
  assert.deepEqual(await readTurnResult(client, id), { status: "done", text: "Finished. CI passed." });
  assert.deepEqual(reads, [["receipt", id], ["history", 1, { minEntryId: 55, maxEntryId: 55 }, 1]]);
});
test("terminal model failure is distinct from a transport failure", async () => {
  const { client, reads } = reader({ id, status: "unanswered", reason: "model_error" });
  assert.deepEqual(await readTurnResult(client, id), { status: "unanswered", reason: "model_error" });
  assert.equal(reads.length, 1);
  assert.equal(isTransportFailure(Error("HTTP request error: Request failed: TypeError: fetch failed")), true);
  assert.equal(isTransportFailure(Error("Agent did not finish: model_error")), false);
  assert.equal(isTransportFailure(Error("GitHub 403 on pulls/310")), false);
});
