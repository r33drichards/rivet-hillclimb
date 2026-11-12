import { test } from "node:test";
import assert from "node:assert/strict";
import { forwardComment, formatProgressEvent, progressEventId, safeProgressEvent, type ProgressEventName } from "../src/hooks/forward-comment.js";
import { progressCommentExtension } from "../src/hooks/config.js";
const api = { taskId: 19, conversationId: 7 } as any;
const call = { id: "call-1", name: "run_js", arguments: { code: "DO_NOT_FORWARD_PROMPT_CODE_SECRET" } };
test("native progress normalization never passes tool inputs, output, reasoning, logs, or provider payloads to formatter", () => {
  const fixtures: [ProgressEventName, unknown[]][] = [
    ["beforeTool", [call]],
    ["afterTool", [call, { isError: true, output: [{ type: "text", text: "DO_NOT_FORWARD_LOGS" }], details: { secret: "DO_NOT_FORWARD_DETAILS" } }]],
    ["afterTools", [17, [18, 19]]],
    ["beforeRequest", [{ messages: [{ content: "DO_NOT_FORWARD_PROMPT" }] }]],
    ["beforeCompact", [{ entries: [{ id: 1, data: "DO_NOT_FORWARD_ENTRY" }], messages: ["DO_NOT_FORWARD_PROMPT"], instructions: "DO_NOT_FORWARD_INSTRUCTIONS" }]],
    ["onYield", [{ content: [{ type: "text", text: "DO_NOT_FORWARD_ANSWER" }, { type: "thinking", thinking: "DO_NOT_FORWARD_REASONING" }] }]],
    ["afterResponse", [{ payload: "DO_NOT_FORWARD_PROVIDER_PAYLOAD", content: [{ type: "toolCall" }] }]],
    ["afterRun", [{ reason: "answer", first: 1, answer: 7, last: 8 }]],
  ];
  for (const [event, input] of fixtures) {
    const safe = safeProgressEvent(event, input, api);
    assert.equal(Object.isFrozen(safe), true);
    assert.doesNotMatch(JSON.stringify(safe), /DO_NOT_FORWARD/);
    assert.doesNotMatch(formatProgressEvent(safe), /DO_NOT_FORWARD/);
    assert.equal(safe.event, event);
  }
});
test("hook fingerprints are stable across retries and volatile metadata but distinguish outcome, round, and task", () => {
  const result = { isError: true, diagnostics: [{ code: "interrupted", severity: "error" }], details: { durationMs: 1 } };
  const first = progressEventId("afterTool", 19, [call, result]);
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(first, progressEventId("afterTool", 19, [{ arguments: { code: call.arguments.code }, name: "run_js", id: "call-1" }, { ...result, details: { durationMs: 9999 }, usage: { totalTokens: 99 } }]));
  assert.notEqual(first, progressEventId("afterTool", 19, [call, { isError: false, diagnostics: [] }]));
  assert.notEqual(first, progressEventId("afterTool", 20, [call, result]));
  const message = { content: [{ type: "text", text: "answer" }, { type: "thinking", thinking: "hidden" }], timestamp: 1, responseId: "response-1" };
  assert.equal(progressEventId("onYield", 19, [message]), progressEventId("onYield", 19, [{ ...message, timestamp: 999, usage: { tokens: 10 } }]));
  assert.notEqual(progressEventId("onYield", 19, [message]), progressEventId("onYield", 19, [{ ...message, responseId: "response-2" }]));
});
test("formatter undefined skips forwarding, and missing session context is a no-op", async () => {
  let formatted = false;
  const hook = forwardComment("beforeTool", { format: safe => { formatted = true; assert.equal(safe.toolName, "run_js"); assert.doesNotMatch(JSON.stringify(safe), /DO_NOT_FORWARD/); return undefined; } });
  const result = await hook(call as any, { ...api, snapshot: async () => ({ actorId: "test-actor" }) } as any, {} as any);
  assert.equal(result, undefined);
  assert.equal(formatted, true);
  formatted = false;
  await hook(call as any, { ...api, snapshot: async () => undefined } as any, {} as any);
  assert.equal(formatted, false);
});
test("forwarding failures are observational and log no exception payload", async () => {
  const original = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...args) => { warnings.push(args); };
  try {
    assert.equal(await forwardComment("beforeTool")(call as any, { ...api, snapshot: async () => { throw Error("DO_NOT_FORWARD_SECRET_URL"); } } as any, {} as any), undefined);
    assert.equal(warnings.length, 1);
    assert.doesNotMatch(JSON.stringify(warnings), /DO_NOT_FORWARD/);
  } finally { console.warn = original; }
  assert.equal(progressCommentExtension.name, "hillclimb-pr-progress");
});
