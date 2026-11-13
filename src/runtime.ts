import { createServer, type Server as HttpServer } from "node:http";
import { prepareRepository } from "./repository.js";
import type { HillclimbJob } from "./github.js";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, stat, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const exec = promisify(execFile);
export const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
export class SessionCheckpointTooLargeError extends Error {
  constructor(bytes: number, limit: number) {
    super(`Session checkpoint is ${(bytes / 1024 / 1024).toFixed(1)} MiB; limit is ${limit / 1024 / 1024} MiB after removing obsolete heaps.`);
    this.name = "SessionCheckpointTooLargeError";
  }
}

/** V8 heaps are complete immutable images, not deltas. Retain the one we restore.
 * Keep session/execution databases, native repo files, .git, and all other stores:
 * their references/artifacts need not be understood or rewritten by this bridge.
 */
export async function compactRuntimeHeaps(data: string): Promise<number> {
  let latest: string;
  try { latest = (await readFile(join(data, "latest-heap"), "utf8")).trim(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0; throw error; }
  if (!/^[0-9a-f]{64}$/.test(latest)) throw new Error("Invalid latest heap reference in session checkpoint.");
  const heaps = join(data, "heaps");
  if (!(await stat(join(heaps, latest))).isFile()) throw new Error("Latest session heap is missing.");
  let removed = 0;
  for (const entry of await readdir(heaps, { withFileTypes: true })) {
    if (entry.isFile() && /^[0-9a-f]{64}$/.test(entry.name) && entry.name !== latest) {
      await rm(join(heaps, entry.name));
      removed++;
    }
  }
  return removed;
}


// Each invocation starts from the last committed checkpoint. No worker-local
// path is authoritative, and a failed call cannot corrupt the saved session.
export async function invokeRuntime(snapshot: Uint8Array | undefined, name: string, args: Record<string, unknown>, options?: { signal?: AbortSignal; repository?: { job: HillclimbJob; token: string }; onPhase?: (phase: string, metadata?: Record<string, number>) => void }) {
  const directory = await mkdtemp(join(tmpdir(), "rivet-mcp-"));
  const archive = join(directory, "checkpoint.tgz");
  const data = join(directory, "data");
  let moduleServer: HttpServer | undefined;
  let workspacePrelude = "";
  let transport: StdioClientTransport | undefined;
  const client = new Client({ name: "rivet-mcp-js", version: "1.0.0" });
  const abort = () => { void transport?.close().catch(() => undefined); };
  options?.signal?.addEventListener("abort", abort, { once: true });
  try {
    options?.signal?.throwIfAborted();
    options?.onPhase?.("restore", { bytes: snapshot?.byteLength || 0 });
    if (snapshot) {
      await writeFile(archive, snapshot);
      await exec("tar", ["-xzf", archive, "-C", directory]);
    }
    const { mkdir } = await import("node:fs/promises");
    await mkdir(data, { recursive: true });
    // Compact legacy checkpoints before launching V8 as well as before saving.
    const restoredHeapsRemoved = await compactRuntimeHeaps(data);
    options?.onPhase?.("prepare", { obsoleteHeapsRemoved: restoredHeapsRemoved });
    const extraArgs: string[] = [];
    if (options?.repository) {
      const { job, token } = options.repository;
      const repo = await prepareRepository(data, job, token);
      const bundle = await readFile(new URL("../assets/isomorphic-git-bundle.mjs", import.meta.url));
      moduleServer = createServer((_req, res) => { res.writeHead(200, { "content-type": "application/javascript" }); res.end(bundle); });
      await new Promise<void>((resolve, reject) => { moduleServer!.once("error", reject); moduleServer!.listen(0, "127.0.0.1", resolve); });
      const address = moduleServer.address() as { port: number };
      const moduleUrl = `http://127.0.0.1:${address.port}/isomorphic-git.mjs`;
      workspacePrelude = `import {git as __runtimeGit} from ${JSON.stringify(moduleUrl)}; globalThis.git=__runtimeGit; globalThis.REPO_DIR=${JSON.stringify(repo)};\n`;
      const config = join(directory, "mcp-repo.json");
      await writeFile(config, JSON.stringify([{ name: "repo", transport: "stdio", command: process.execPath,
        args: ["--import", new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url).pathname, new URL("./repo-tools.ts", import.meta.url).pathname],
        env: { HILLCLIMB_REPO_DIR: repo, HILLCLIMB_GITHUB_TOKEN: token, HILLCLIMB_JOB: JSON.stringify(job) },
      }]), { mode: 0o600 });
      const policy = join(directory, "repo.rego");
      await writeFile(policy, 'package mcp.tools\ndefault allow = false\nallow if { input.server == "repo" }\n');
      const fsPolicy = join(directory, "filesystem.rego");
      await writeFile(fsPolicy, `package mcp.filesystem\ndefault allow = false\nallow if { valid(input.path); not input.destination }\nallow if { valid(input.path); valid(input.destination) }\nvalid(path) if { path == ${JSON.stringify(repo)} }\nvalid(path) if { startswith(path, ${JSON.stringify(repo + "/")}) }\n`);
      const fsGuard = join(directory, "filesystem-guard.js");
      await writeFile(fsGuard, `const ROOT=${JSON.stringify(repo)};
async function pre(input) {
  if (input.operation === "symlink") return false;
  for (const path of [input.path, input.destination].filter(Boolean)) {
    if (typeof path !== "string" || path.includes("\\0") || path.split("/").includes("..") || (path !== ROOT && !path.startsWith(ROOT+"/"))) return false;
    const parts=path.slice(ROOT.length).split("/").filter(p=>p && p!==".");
    if (parts[0]?.toLowerCase() === ".git" && parts[1]?.toLowerCase() === "config" && !["readFile","stat","lstat","readlink","exists"].includes(input.operation)) return false;
    let current=ROOT;
    for (let index=0;index<parts.length;index++) {
      current+="/"+parts[index];
      try {
        const stat=await fs.lstat(current);
        if (stat.isSymbolicLink() && !(index===parts.length-1 && ["lstat","readlink","unlink","remove"].includes(input.operation))) return false;
      } catch(error) { if (String(error).includes("ENOENT")) break; throw error; }
    }
  }
  return true;
}`);
      const modulePolicy = join(directory, "modules.rego");
      await writeFile(modulePolicy, `package mcp.modules\ndefault allow = false\nallow if { input.specifier_type == "url"; input.resolved_url == ${JSON.stringify(moduleUrl)} }\n`);
      extraArgs.push("--allow-external-modules", "--mcp-config", config, "--policies-json", JSON.stringify({
        mcp_tools: { policies: [{ url: new URL("file://" + policy).href }] },
        filesystem: { pre: [{ url: new URL("file://" + fsGuard).href, capabilities: ["fs"] }], policies: [{ url: new URL("file://" + fsPolicy).href }] },
        modules: { policies: [{ url: new URL("file://" + modulePolicy).href }] },
      }));
    }
    const executionTimeout = options?.repository ? 120 : 15;
    transport = new StdioClientTransport({
      command: process.env.MCP_V8_BINARY || "mcp-v8",
      args: ["--session-id", "actor", "--heap-store", "dir", "--heap-dir", join(data, "heaps"),
        "--session-db-path", join(data, "sessions"), "--execution-timeout", String(executionTimeout), "--max-concurrent-executions", "1", ...extraArgs],
      // Do not pass Rivet or ChatGPT credentials into the code execution process.
      env: { PATH: process.env.PATH || "/usr/bin:/bin", HOME: directory, TMPDIR: directory },
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4000); });
    try {
      options?.signal?.throwIfAborted();
      options?.onPhase?.("runtime_start");
      await client.connect(transport, { timeout: 30_000 });
      options?.onPhase?.("execute");
      let result: unknown;
      if (name === "__list_tools") result = await client.listTools();
      else {
        let heap: string | undefined;
        try { heap = await readFile(join(data, "latest-heap"), "utf8"); } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        }
        const submitted = unpack(await client.callTool({ name, arguments: { code: workspacePrelude + args.code, heap, execution_timeout_secs: executionTimeout, heap_memory_max_mb: options?.repository ? 256 : 8 } }));
        if (typeof submitted.execution_id !== "string") throw new Error("mcp-js did not return an execution ID");
        const execution_id = submitted.execution_id;
        const deadline = Date.now() + (executionTimeout + 15) * 1000;
        let execution: Record<string, unknown>;
        do {
          options?.signal?.throwIfAborted();
          if (Date.now() > deadline) throw new Error("JavaScript execution timed out");
          await delay(25);
          execution = unpack(await client.callTool({ name: "get_execution", arguments: { execution_id } }));
        } while (["running", "pending", "queued"].includes(String(execution.status)));
        const output = unpack(await client.callTool({ name: "get_execution_output", arguments: { execution_id, byte_offset: 0, byte_limit: 64_000 } }));
        if (execution.status === "completed" && typeof execution.heap === "string") {
          await writeFile(join(data, "latest-heap"), execution.heap);
        }
        result = { ...execution, output };
      }
      await client.close();
      transport = undefined;
      const obsoleteHeapsRemoved = await compactRuntimeHeaps(data);
      options?.onPhase?.("archive", { obsoleteHeapsRemoved });
      await exec("tar", ["-czf", archive, "-C", directory, "data"], { maxBuffer: 1024 * 1024 });
      const checkpoint = await readFile(archive);
      options?.onPhase?.("archive_ready", { bytes: checkpoint.length });
      const limit = options?.repository ? 128 * 1024 * 1024 : MAX_ARCHIVE_BYTES;
      if (checkpoint.length > limit) throw new SessionCheckpointTooLargeError(checkpoint.length, limit);
      return { result, checkpoint };
    } catch (error) {
      if (error instanceof SessionCheckpointTooLargeError) throw error;
      throw new Error(`${error instanceof Error ? error.message : error}${stderr ? `\n${stderr}` : ""}`);
    }
  } finally {
    options?.signal?.removeEventListener("abort", abort);
    if (transport) await transport.close().catch(() => undefined);
    if (moduleServer) await new Promise<void>(resolve => moduleServer!.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}

function unpack(result: unknown): Record<string, unknown> {
  const message = result as { isError?: boolean; content?: { type: string; text?: string }[] };
  const text = message.content?.filter(c => c.type === "text").map(c => c.text).join("\n") || "{}";
  if (message.isError) throw new Error(text);
  return JSON.parse(text);
}
