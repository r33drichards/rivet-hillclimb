import { test } from "node:test";
import assert from "node:assert/strict";
import { exclusiveWorkspaceCall, type WorkspaceCallState } from "../src/workspace-call.js";
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const busy = () => new Error("busy");
test("same request shares original operation while different or missing IDs cannot overlap", async () => {
  const state: WorkspaceCallState = { busy: false };
  const sql = deferred<string>(); let executions = 0;
  const signal = new AbortController().signal;
  const execute = async () => { executions++; return sql.promise; };
  const first = exclusiveWorkspaceCall(state, "original", "run_js", signal, execute, busy);
  const retry = exclusiveWorkspaceCall(state, "original", "run_js", signal, execute, busy);
  assert.equal(first, retry);
  await assert.rejects(exclusiveWorkspaceCall(state, "other", "run_js", signal, execute, busy), /busy/);
  await assert.rejects(exclusiveWorkspaceCall(state, undefined, "run_js", signal, execute, busy), /busy/);
  assert.equal(executions, 1);
  assert.equal(state.active?.requestId, "original");
  assert.equal(state.busy, true);
  sql.resolve("receipt");
  assert.equal(await first, "receipt");
  assert.equal(await retry, "receipt");
  assert.equal(state.busy, false);
  assert.equal(state.active, undefined);
});
test("cancellation during unabortable SQL retains exclusivity and stops runtime execution afterwards", async () => {
  const state: WorkspaceCallState = { busy: false };
  const dispatch = new AbortController(); const sql = deferred<void>(); let runtimeCalls = 0;
  const call = exclusiveWorkspaceCall(state, "one", "run_js", dispatch.signal, async signal => {
    await sql.promise;
    signal.throwIfAborted();
    runtimeCalls++;
  }, busy);
  await Promise.resolve(); dispatch.abort();
  assert.equal(state.controller?.signal.aborted, true);
  assert.equal(state.busy, true, "abort cannot pretend the SQL request unwound");
  await assert.rejects(exclusiveWorkspaceCall(state, "two", "run_js", dispatch.signal, async () => {}, busy), /busy/);
  sql.resolve();
  await assert.rejects(call, { name: "AbortError" });
  assert.equal(runtimeCalls, 0);
  assert.equal(state.busy, false);
});
