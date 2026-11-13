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

test("cancellation interrupts running JavaScript without saving a checkpoint", async () => {
  const controller = new AbortController();
  const running = invokeRuntime(undefined, "run_js", { code: "while(true){}" }, { signal: controller.signal });
  setTimeout(() => controller.abort(), 500);
  await assert.rejects(running);
});

test("repeated executions retain one complete heap instead of accumulating historical snapshots", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);
  const dir = await mkdtemp(join(tmpdir(), "rivet-heap-growth-"));
  try {
    let checkpoint: Buffer | undefined;
    const sizes: number[] = [];
    for (let index = 1; index <= 6; index++) {
      const next = await invokeRuntime(checkpoint, "run_js", { code: "globalThis.payload ??= Array.from({length:8000},()=>Math.random().toString(36).slice(2)).join('');globalThis.turn=(globalThis.turn||0)+1;console.log('turn='+turn);" });
      checkpoint = next.checkpoint;
      assert.match((next.result as any).output.data, new RegExp(`turn=${index}`));
      sizes.push(checkpoint.length);
      const file = join(dir, "checkpoint.tgz"); await writeFile(file, checkpoint);
      const names = (await exec("tar", ["-tzf", file])).stdout.split("\n");
      assert.equal(names.filter(name => /^data\/heaps\/[a-f0-9]{64}$/.test(name)).length, 1);
      assert.ok(names.includes("data/sessions/executions/db"), "execution metadata is retained");
    }
    assert.ok(Math.max(...sizes) < sizes[0] * 1.8, `checkpoint growth must stay bounded: ${sizes}`);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("legacy archive compaction preserves latest globals and opaque session artifacts", async () => {
  const { mkdtemp, mkdir, writeFile, readFile, rm } = await import("node:fs/promises");
  const { randomBytes } = await import("node:crypto");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);
  const dir = await mkdtemp(join(tmpdir(), "rivet-legacy-heaps-"));
  try {
    const initial = await invokeRuntime(undefined, "run_js", { code: "globalThis.legacyCounter=41" });
    const archive = join(dir, "checkpoint.tgz"); await writeFile(archive, initial.checkpoint);
    await exec("tar", ["-xzf", archive, "-C", dir]);
    const obsolete = "f".repeat(64);
    await writeFile(join(dir, "data/heaps", obsolete), randomBytes(2 * 1024 * 1024));
    await mkdir(join(dir, "data/sessions/blobs"), { recursive: true });
    await writeFile(join(dir, "data/sessions/blobs/opaque-artifact"), "preserve me");
    await exec("tar", ["-czf", archive, "-C", dir, "data"]);
    const migrated = await invokeRuntime(await readFile(archive), "run_js", { code: "legacyCounter++;console.log(legacyCounter)" });
    assert.match((migrated.result as any).output.data, /42/);
    await writeFile(archive, migrated.checkpoint);
    const entries = (await exec("tar", ["-tzf", archive])).stdout.split("\n");
    assert.ok(!entries.includes(`data/heaps/${obsolete}`));
    assert.ok(entries.includes("data/sessions/blobs/opaque-artifact"));
    assert.ok(entries.includes("data/sessions/db"));
    assert.equal(entries.filter(name => /^data\/heaps\/[a-f0-9]{64}$/.test(name)).length, 1);
    assert.ok(migrated.checkpoint.length < 1024 * 1024, "the obsolete 2 MiB random heap was not retained");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
