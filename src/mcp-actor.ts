import { githubToken, GITHUB_OWNER, type HillclimbJob } from "./github.js";
import { actor, UserError } from "rivetkit";
import { db } from "rivetkit/db";
import { authorize } from "./auth.js";
import { invokeRuntime } from "./runtime.js";

export const mcpJs = actor({
  db: db({ onMigrate: async (db) => {
    await db.execute("CREATE TABLE IF NOT EXISTS checkpoint (part INTEGER PRIMARY KEY, data TEXT NOT NULL)");
    await db.execute("CREATE TABLE IF NOT EXISTS checkpoint_head (id INTEGER PRIMARY KEY CHECK (id = 1), generation TEXT NOT NULL)");
    await db.execute("CREATE TABLE IF NOT EXISTS checkpoint_chunk (generation TEXT NOT NULL, part INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (generation, part))");
    await db.execute("CREATE TABLE IF NOT EXISTS receipt (id TEXT PRIMARY KEY, result TEXT NOT NULL)");
  } }),
  state: { repository: null as HillclimbJob | null },
  createVars: () => ({ busy: false }),
  onBeforeConnect: authorize,
  options: { actionTimeout: 240_000, sleepTimeout: 5_000 },
  actions: {
    configureRepository: (c, job: HillclimbJob) => {
      if (job.owner !== GITHUB_OWNER || !(c.key[0] === "hillclimb" && c.key.length === 2)) throw new UserError("Repository job does not match this actor.");
      if (c.vars.busy) throw new UserError("A tool is running.");
      if (c.state.repository && (c.state.repository.repo !== job.repo || c.state.repository.number !== job.number)) throw new UserError("Cannot replace an existing session's repository.");
      c.state.repository = job;
    },
    callTool: async (c, name: string, args: Record<string, unknown>, requestId?: string) => {
      if (c.vars.busy) throw new UserError("A tool call is already running for this session.");
      if (!["run_js", "__list_tools"].includes(name)) throw new UserError("Unsupported tool.");
      c.vars.busy = true;
      try {
        return await c.keepAwake((async () => {
          // Receipts make the agent's interrupted tool calls safe to retry.
          if (requestId) {
            const rows = await c.db.execute("SELECT result FROM receipt WHERE id = ?", requestId) as { result: string }[];
            if (rows[0]) return JSON.parse(rows[0].result);
          }
          const heads = await c.db.execute("SELECT generation FROM checkpoint_head WHERE id = 1") as { generation: string }[];
          const rows = heads[0]
            ? await c.db.execute("SELECT data FROM checkpoint_chunk WHERE generation = ? ORDER BY part", heads[0].generation) as { data: string }[]
            : await c.db.execute("SELECT data FROM checkpoint ORDER BY part") as { data: string }[];
          const snapshot = rows.length ? Buffer.from(rows.map(r => r.data).join(""), "base64") : undefined;
          const { result, checkpoint } = await invokeRuntime(snapshot, name, args, c.state.repository ? { repository: { job: c.state.repository, token: await githubToken(c.state.repository) } } : undefined);
          const encoded = checkpoint.toString("base64");
          const generation = crypto.randomUUID();
          // Write a new immutable generation in small transactions. Only the
          // final pointer swap and receipt share a transaction, so large clones
          // never require one huge SQLite transaction and crashes keep the old head.
          for (let offset = 0, part = 0; offset < encoded.length; offset += 48_000, part++) {
            await c.db.execute("INSERT INTO checkpoint_chunk (generation, part, data) VALUES (?, ?, ?)", generation, part, encoded.slice(offset, offset + 48_000));
          }
          await c.db.transaction(async (tx) => {
            await tx.execute("INSERT INTO checkpoint_head (id, generation) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET generation = excluded.generation", generation);
            if (requestId) await tx.execute("INSERT INTO receipt (id, result) VALUES (?, ?)", requestId, JSON.stringify(result));
          }, { name: "mcp.checkpoint" });
          // Bound garbage-collection work per statement. Orphaned generations
          // from an interrupted write are collected on the next successful call.
          while ((await c.db.execute("SELECT part FROM checkpoint_chunk WHERE generation != ? LIMIT 1", generation)).length) {
            await c.db.execute("DELETE FROM checkpoint_chunk WHERE rowid IN (SELECT rowid FROM checkpoint_chunk WHERE generation != ? LIMIT 16)", generation);
          }
          return result;
        })());
      } finally { c.vars.busy = false; }
    },
    status: async (c) => ({ checkpointParts: (await c.db.execute("SELECT part FROM checkpoint_chunk WHERE generation = (SELECT generation FROM checkpoint_head WHERE id = 1)")).length }),
  },
});
