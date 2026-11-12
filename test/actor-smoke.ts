import assert from "node:assert/strict";
import { createClient } from "rivetkit/client";
import type { registry } from "../src/server.js";
const client = createClient<typeof registry>(process.env.RIVET_ENDPOINT || "http://127.0.0.1:6420");
const key = ["smoke", crypto.randomUUID()];
const params = { authToken: process.env.APP_ACCESS_TOKEN! };
const actor = client.mcpJs.getOrCreate(key, { params });
try {
  const first = await actor.callTool("run_js", { code: "globalThis.counter=41;console.log(counter)" }, "first");
  assert.match(JSON.stringify(first), /41/);
  const second = await actor.callTool("run_js", { code: "globalThis.counter+=1;console.log(counter)" }, "second");
  assert.match(JSON.stringify(second), /42/);
  console.log("Waiting for the actor idle timeout before checking recovery...");
  await new Promise(resolve => setTimeout(resolve, 32_000));
  const afterWake = await actor.callTool("run_js", { code: "console.log(counter)" }, "after-wake");
  assert.match(JSON.stringify(afterWake), /42/);
  const retry = await actor.callTool("run_js", { code: "globalThis.counter+=1;console.log(counter)" }, "second");
  assert.deepEqual(retry, second);
  await assert.rejects(client.mcpJs.getOrCreate(key, { params: { authToken: "invalid" } }).status());
  console.log("PASS: actor checkpoint, session continuity, retry receipt, unauthorized access rejection");
} finally { await client.dispose(); }
