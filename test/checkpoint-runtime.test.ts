import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { readCheckpoint, writeCheckpoint, garbageCollectCheckpointBatch, CHECKPOINT_READ_PARTS, CHECKPOINT_WRITE_PARTS, CHECKPOINT_PART_CHARS, CHECKPOINT_GC_PARTS, type CheckpointDatabase } from "../src/mcp-actor.js";
function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("CREATE TABLE checkpoint(part INTEGER PRIMARY KEY,data TEXT NOT NULL);CREATE TABLE checkpoint_head(id INTEGER PRIMARY KEY,generation TEXT NOT NULL);CREATE TABLE checkpoint_chunk(generation TEXT NOT NULL,part INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(generation,part));CREATE TABLE checkpoint_retired(generation TEXT PRIMARY KEY);CREATE TABLE receipt(id TEXT PRIMARY KEY,result TEXT NOT NULL)");
  const observed: { sql: string; params: unknown[]; rows: number }[] = [];
  let failReceipt = false;
  const db: CheckpointDatabase = {
    execute: async (sql, ...params) => {
      if (failReceipt && sql.startsWith("INSERT INTO receipt")) throw Error("injected receipt failure");
      const rows = sqlite.prepare(sql).all(...params);
      observed.push({ sql, params, rows: rows.length });
      return rows;
    },
    transaction: async fn => {
      sqlite.exec("BEGIN");
      try { const value = await fn(db); sqlite.exec("COMMIT"); return value; }
      catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    },
  };
  return { sqlite, db, observed, failReceipt: () => { failReceipt = true; } };
}
test("large checkpoint reads are paged, inserts batched, and retirement is outside the publish transaction", async () => {
  const f = fixture();
  try {
    const first = randomBytes(4 * 1024 * 1024 + 7);
    const oldGeneration = await writeCheckpoint(f.db, first, { output: "old" }, "old-call");
    assert.deepEqual(await readCheckpoint(f.db), first);
    assert.ok(f.observed.filter(x => x.sql.startsWith("SELECT part, data")).every(x => x.rows <= CHECKPOINT_READ_PARTS));
    const inserts = f.observed.filter(x => x.sql.startsWith("INSERT INTO checkpoint_chunk"));
    assert.ok(inserts.every(x => x.params.length <= CHECKPOINT_WRITE_PARTS * 3));
    assert.ok(inserts.length < Math.ceil(first.toString("base64").length / CHECKPOINT_PART_CHARS), "more than one part is persisted per insertion");
    const second = randomBytes(90_001);
    const newGeneration = await writeCheckpoint(f.db, second, { output: "new" }, "new-call");
    assert.ok(Number(f.sqlite.prepare("SELECT COUNT(*) AS n FROM checkpoint_chunk WHERE generation=?").get(oldGeneration)!.n) > 0, "old checkpoint not removed in tool publication");
    const before = Number(f.sqlite.prepare("SELECT COUNT(*) AS n FROM checkpoint_chunk WHERE generation=?").get(oldGeneration)!.n);
    assert.equal(await garbageCollectCheckpointBatch(f.db), true);
    const after = Number(f.sqlite.prepare("SELECT COUNT(*) AS n FROM checkpoint_chunk WHERE generation=?").get(oldGeneration)!.n);
    assert.equal(before - after, CHECKPOINT_GC_PARTS);
    while (await garbageCollectCheckpointBatch(f.db)) {}
    assert.deepEqual(await readCheckpoint(f.db), second);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM checkpoint_chunk WHERE generation=?").get(oldGeneration)!.n, 0);
    assert.equal(f.sqlite.prepare("SELECT generation FROM checkpoint_head").get()!.generation, newGeneration);
    assert.deepEqual(JSON.parse(String(f.sqlite.prepare("SELECT result FROM receipt WHERE id='new-call'").get()!.result)), { output: "new" });
  } finally { f.sqlite.close(); }
});
test("failed publication keeps previous checkpoint and receipt atomic; GC never deletes the current head", async () => {
  const f = fixture();
  try {
    const original = randomBytes(100_001);
    const generation = await writeCheckpoint(f.db, original, { output: "saved" }, "original");
    f.failReceipt();
    await assert.rejects(writeCheckpoint(f.db, randomBytes(150_002), { output: "lost" }, "failed"), /injected receipt failure/);
    assert.deepEqual(await readCheckpoint(f.db), original);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM receipt WHERE id='failed'").get()!.n, 0);
    f.sqlite.prepare("INSERT OR IGNORE INTO checkpoint_retired VALUES (?)").run(generation);
    while (await garbageCollectCheckpointBatch(f.db)) {}
    assert.deepEqual(await readCheckpoint(f.db), original);
    assert.equal(f.sqlite.prepare("SELECT COUNT(DISTINCT generation) AS n FROM checkpoint_chunk").get()!.n, 1);
  } finally { f.sqlite.close(); }
});
test("legacy checkpoint is readable and cancellation never publishes a partial generation", async () => {
  const f = fixture();
  try {
    const original = randomBytes(144_013);
    const encoded = original.toString("base64");
    for (let offset = 0, part = 0; offset < encoded.length; offset += CHECKPOINT_PART_CHARS, part++) f.sqlite.prepare("INSERT INTO checkpoint VALUES (?,?)").run(part, encoded.slice(offset, offset + CHECKPOINT_PART_CHARS));
    assert.deepEqual(await readCheckpoint(f.db), original);
    const abort = new AbortController(); abort.abort();
    await assert.rejects(writeCheckpoint(f.db, randomBytes(100), {}, "cancelled", abort.signal));
    while (await garbageCollectCheckpointBatch(f.db)) {}
    assert.deepEqual(await readCheckpoint(f.db), original);
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM checkpoint_head").get()!.n, 0);
  } finally { f.sqlite.close(); }
});
