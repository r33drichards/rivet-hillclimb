import { githubToken, GITHUB_OWNER, type HillclimbJob } from "./github.js";
import { actor, UserError } from "rivetkit";
import { db } from "rivetkit/db";
import { authorize } from "./auth.js";
import { invokeRuntime, SessionCheckpointTooLargeError } from "./runtime.js";

export const CHECKPOINT_PART_CHARS = 48_000;
export const CHECKPOINT_READ_PARTS = 32;
export const CHECKPOINT_WRITE_PARTS = 16;
export const CHECKPOINT_GC_PARTS = 32;
export interface CheckpointDatabase {
  execute(sql: string, ...params: any[]): Promise<any>;
  transaction<T>(fn: (tx: Pick<CheckpointDatabase, "execute">) => Promise<T>, options: { name: string }): Promise<T>;
}
export async function readCheckpoint(database: Pick<CheckpointDatabase, "execute">): Promise<Buffer | undefined> {
  const heads = await database.execute("SELECT generation FROM checkpoint_head WHERE id = 1") as { generation: string }[];
  const buffers: Buffer[] = [];
  let nextPart = 0;
  while (true) {
    const rows = (heads[0]
      ? await database.execute("SELECT part, data FROM checkpoint_chunk WHERE generation = ? AND part >= ? ORDER BY part LIMIT ?", heads[0].generation, nextPart, CHECKPOINT_READ_PARTS)
      : await database.execute("SELECT part, data FROM checkpoint WHERE part >= ? ORDER BY part LIMIT ?", nextPart, CHECKPOINT_READ_PARTS)) as { part: number; data: string }[];
    if (!rows.length) break;
    for (const row of rows) {
      if (row.part !== nextPart++) throw new Error("Session checkpoint is incomplete.");
      buffers.push(Buffer.from(row.data, "base64"));
    }
    if (rows.length < CHECKPOINT_READ_PARTS) break;
  }
  return buffers.length ? Buffer.concat(buffers) : undefined;
}
export async function writeCheckpoint(database: CheckpointDatabase, checkpoint: Buffer, result: unknown, requestId?: string, signal?: AbortSignal) {
  const encoded = checkpoint.toString("base64");
  const generation = crypto.randomUUID();
  try {
    for (let offset = 0, part = 0; offset < encoded.length;) {
      signal?.throwIfAborted();
      const values: unknown[] = [];
      const rows: string[] = [];
      for (let count = 0; count < CHECKPOINT_WRITE_PARTS && offset < encoded.length; count++, part++, offset += CHECKPOINT_PART_CHARS) {
        rows.push("(?, ?, ?)");
        values.push(generation, part, encoded.slice(offset, offset + CHECKPOINT_PART_CHARS));
      }
      await database.execute(`INSERT INTO checkpoint_chunk (generation, part, data) VALUES ${rows.join(", ")}`, ...values);
    }
    signal?.throwIfAborted();
    // Publish the checkpoint and receipt together; never garbage-collect the
    // previous generation until this pointer swap is durable.
    await database.transaction(async tx => {
      await tx.execute("INSERT OR IGNORE INTO checkpoint_retired (generation) SELECT generation FROM checkpoint_head WHERE id = 1 AND generation != ?", generation);
      await tx.execute("INSERT INTO checkpoint_head (id, generation) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET generation = excluded.generation", generation);
      if (requestId) await tx.execute("INSERT INTO receipt (id, result) VALUES (?, ?)", requestId, JSON.stringify(result));
    }, { name: "mcp.checkpoint.publish" });
    return generation;
  } catch (error) {
    // Failed staging generations can be collected without touching the old head.
    await database.execute("INSERT OR IGNORE INTO checkpoint_retired (generation) VALUES (?)", generation).catch(() => undefined);
    throw error;
  }
}
export async function garbageCollectCheckpointBatch(database: Pick<CheckpointDatabase, "execute">): Promise<boolean> {
  // A commit acknowledgment can be lost after publication; never keep a GC
  // alarm alive for a generation that is still the current head.
  await database.execute("DELETE FROM checkpoint_retired WHERE generation = (SELECT generation FROM checkpoint_head WHERE id = 1)");
  const retired = await database.execute("SELECT generation FROM checkpoint_retired LIMIT 1") as { generation: string }[];
  if (!retired[0]) return false;
  const generation = retired[0].generation;
  await database.execute("DELETE FROM checkpoint_chunk WHERE rowid IN (SELECT rowid FROM checkpoint_chunk WHERE generation = ? AND generation != COALESCE((SELECT generation FROM checkpoint_head WHERE id = 1), '') LIMIT ?)", generation, CHECKPOINT_GC_PARTS);
  const remaining = await database.execute("SELECT part FROM checkpoint_chunk WHERE generation = ? LIMIT 1", generation) as unknown[];
  if (!remaining.length) await database.execute("DELETE FROM checkpoint_retired WHERE generation = ?", generation);
  return (await database.execute("SELECT generation FROM checkpoint_retired LIMIT 1")).length > 0;
}

export const mcpJs = actor({
  db: db({ onMigrate: async (db) => {
    await db.execute("CREATE TABLE IF NOT EXISTS checkpoint (part INTEGER PRIMARY KEY, data TEXT NOT NULL)");
    await db.execute("CREATE TABLE IF NOT EXISTS checkpoint_head (id INTEGER PRIMARY KEY CHECK (id = 1), generation TEXT NOT NULL)");
    await db.execute("CREATE TABLE IF NOT EXISTS checkpoint_chunk (generation TEXT NOT NULL, part INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (generation, part))");
    await db.execute("CREATE TABLE IF NOT EXISTS checkpoint_retired (generation TEXT PRIMARY KEY)");
    await db.execute("CREATE TABLE IF NOT EXISTS receipt (id TEXT PRIMARY KEY, result TEXT NOT NULL)");
  } }),
  state: { repository: null as HillclimbJob | null, cancelled: false,
    checkpointBytes: null as number | null, checkpointParts: null as number | null, phase: "idle", lastError: null as string | null },
  createVars: () => ({ busy: false, controller: undefined as AbortController | undefined }),
  onBeforeConnect: authorize,
  options: { actionTimeout: 240_000, sleepTimeout: 5_000 },
  actions: {
    configureRepository: (c, job: HillclimbJob) => {
      if (job.owner !== GITHUB_OWNER || !(c.key[0] === "hillclimb" && c.key.length === 2)) throw new UserError("Repository job does not match this actor.");
      if (c.vars.busy) throw new UserError("A tool is running.");
      if (c.state.repository && (c.state.repository.repo !== job.repo || c.state.repository.number !== job.number)) throw new UserError("Cannot replace an existing session's repository.");
      c.state.repository = job;
      c.state.cancelled = false;
    },
    cancel: (c) => { c.state.cancelled = true; c.vars.controller?.abort(); },
    callTool: async (c, name: string, args: Record<string, unknown>, requestId?: string) => {
      if (c.state.cancelled) throw new UserError("Hillclimb workspace was cancelled.");
      if (c.vars.busy) throw new UserError("A tool call is already running for this session.");
      if (!["run_js", "__list_tools"].includes(name)) throw new UserError("Unsupported tool.");
      c.vars.busy = true;
      c.state.phase = "receipt";
      c.state.lastError = null;
      c.vars.controller = new AbortController();
      try {
        return await c.keepAwake((async () => {
          // Receipts make the agent's interrupted tool calls safe to retry.
          if (requestId) {
            const rows = await c.db.execute("SELECT result FROM receipt WHERE id = ?", requestId) as { result: string }[];
            if (rows[0]) { c.state.phase = "done"; return JSON.parse(rows[0].result); }
          }
          c.state.phase = "read_checkpoint";
          const snapshot = await readCheckpoint(c.db);
          c.state.checkpointBytes = snapshot?.length || 0;
          c.log.info({ message: "Workspace checkpoint restored", bytes: c.state.checkpointBytes });
          const { result, checkpoint } = await invokeRuntime(snapshot, name, args, { signal: c.vars.controller!.signal,
            onPhase: (phase, metadata) => { c.state.phase = phase; if (metadata) c.log.info({ message: "Workspace runtime phase", phase, ...metadata }); },
            ...(c.state.repository ? { repository: { job: c.state.repository, token: await githubToken(c.state.repository) } } : {}) });
          if (c.state.cancelled) throw new UserError("Hillclimb workspace was cancelled.");
          c.state.phase = "persist_checkpoint";
          await writeCheckpoint(c.db, checkpoint, result, requestId, c.vars.controller!.signal);
          c.state.checkpointBytes = checkpoint.length;
          c.state.checkpointParts = Math.ceil((4 * Math.ceil(checkpoint.length / 3)) / CHECKPOINT_PART_CHARS);
          c.state.phase = "done";
          c.log.info({ message: "Workspace checkpoint saved", bytes: checkpoint.length, parts: c.state.checkpointParts });
          return result;
        })());
      } catch (error) {
        const known = error instanceof SessionCheckpointTooLargeError;
        c.state.lastError = known ? error.message : `Workspace ${c.state.phase} failed (${error instanceof Error ? error.name : "error"}).`;
        const details = (error instanceof Error ? error.message : String(error)).replace(/(?:cloud_api_|gh[pous]_|sk_)[A-Za-z0-9_-]+/g, "[redacted]");
        c.log.error({ message: "Workspace tool failed", phase: c.state.phase, checkpointBytes: c.state.checkpointBytes, checkpointParts: c.state.checkpointParts, details });
        throw new UserError(c.state.lastError);
      } finally {
        c.vars.busy = false;
        c.vars.controller = undefined;
        await c.schedule.after(0, "garbageCollect").catch(() => undefined);
      }
    },
    garbageCollect: async (c): Promise<void> => {
      try {
        if (await garbageCollectCheckpointBatch(c.db)) await c.schedule.after(0, "garbageCollect");
      } catch {
        c.log.warn({ message: "Checkpoint garbage collection will retry" });
        await c.schedule.after(30_000, "garbageCollect");
      }
    },
    status: async (c) => ({
      checkpointParts: c.state.checkpointParts ?? (await c.db.execute("SELECT COUNT(*) AS parts FROM checkpoint_chunk WHERE generation = (SELECT generation FROM checkpoint_head WHERE id = 1)") as { parts: number }[])[0]?.parts ?? 0,
      checkpointBytes: c.state.checkpointBytes ?? null, phase: c.state.phase ?? "idle", lastError: c.state.lastError ?? null,
    }),
  },
});
