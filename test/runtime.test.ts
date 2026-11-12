import { test } from "node:test";
import assert from "node:assert/strict";
import { invokeRuntime } from "../src/runtime.js";

test("heap survives a fresh process and sessions stay isolated", async () => {
  const first = await invokeRuntime(undefined, "run_js", { code: "globalThis.counter = 41; console.log(counter)" });
  assert.match(JSON.stringify(first.result), /41/);
  const second = await invokeRuntime(first.checkpoint, "run_js", { code: "globalThis.counter += 1; console.log(counter)" });
  assert.match(JSON.stringify(second.result), /42/);
  const isolated = await invokeRuntime(undefined, "run_js", { code: "console.log(typeof counter)" });
  assert.match(JSON.stringify(isolated.result), /undefined/);
});

test("host capabilities remain unavailable", async () => {
  const call = await invokeRuntime(undefined, "run_js", { code: "await fetch('https://example.com')" });
  assert.match(JSON.stringify(call.result), /failed|denied|not defined/i);
});
