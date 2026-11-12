import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { git, repositoryMeta, repositoryPath, writeRepositoryFile } from "./repository.js";
import { TRIGGER_LABEL, type HillclimbJob } from "./github.js";
const root = process.env.HILLCLIMB_REPO_DIR!;
const token = process.env.HILLCLIMB_GITHUB_TOKEN!;
const job: HillclimbJob = JSON.parse(process.env.HILLCLIMB_JOB!);
const schema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object" as const, properties, required, additionalProperties: false });
const str = { type: "string" };
const tools = [
  { name: "read_file", description: "Read a UTF-8 repository file; optional line offset and limit.", inputSchema: schema({ path: str, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 2000 } }, ["path"]) },
  { name: "write_file", description: "Write a UTF-8 file in this PR's clone.", inputSchema: schema({ path: str, content: str }, ["path", "content"]) },
  { name: "list_files", description: "List a repository directory, excluding .git.", inputSchema: schema({ path: str }) },
  { name: "delete_file", description: "Remove one repository file.", inputSchema: schema({ path: str }, ["path"]) },
  { name: "diff", description: "Inspect git diff and untracked filenames.", inputSchema: schema({}) },
  { name: "checks", description: "Read GitHub Actions runs and checks for the live PR head, including pending states.", inputSchema: schema({}) },
  { name: "logs", description: "Read a GitHub Actions job log, bounded to 32 KB.", inputSchema: schema({ job_id: { type: "integer", minimum: 1 } }, ["job_id"]) },
  { name: "jobs", description: "List jobs in a workflow run.", inputSchema: schema({ run_id: { type: "integer", minimum: 1 } }, ["run_id"]) },
  { name: "sync_base", description: "Fetch and rebase onto the PR's actual base before diagnosing CI. If conflicts occur, edit files then use continue_rebase.", inputSchema: schema({}) },
  { name: "continue_rebase", description: "Stage resolved paths and continue an in-progress rebase.", inputSchema: schema({ paths: { type: "array", items: str, minItems: 1 } }, ["paths"]) },
  { name: "commit_push", description: "Commit explicit paths and push this PR branch with a lease against its last observed head. Also pushes a completed rebase when there is no diff.", inputSchema: schema({ message: str, paths: { type: "array", items: str } }, ["message", "paths"]) },
  { name: "comment", description: "Post or update the hillclimb summary comment on this PR.", inputSchema: schema({ body: str }, ["body"]) },
];
async function api(path: string, init: RequestInit = {}): Promise<any> {
  const response = await fetch(`https://api.github.com/repos/${job.owner}/${job.repo}/${path}`, {
    ...init, headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json", ...init.headers },
  });
  if (!response.ok) throw new Error(`GitHub returned ${response.status} for ${path}`);
  return response.json();
}
async function activePr() {
  const pr = await api(`pulls/${job.number}`);
  if (pr.state !== "open" || !pr.labels.some((l: any) => l.name === TRIGGER_LABEL)) throw new Error("PR is closed or the trigger label was removed; stop.");
  if (pr.head.repo?.full_name?.toLowerCase() !== `${job.owner}/${job.repo}`.toLowerCase()) throw new Error("Cannot push a fork's branch with this repository token.");
  return pr;
}
async function invoke(name: string, a: any): Promise<unknown> {
  switch (name) {
    case "read_file": { const lines = (await readFile(await repositoryPath(root, a.path), "utf8")).split("\n"); const offset = a.offset || 0; return { text: lines.slice(offset, offset + (a.limit || 500)).join("\n").slice(0, 120_000), totalLines: lines.length }; }
    case "write_file": await writeRepositoryFile(root, a.path, a.content); return { written: a.path };
    case "list_files": return (await readdir(await repositoryPath(root, a.path || "."), { withFileTypes: true })).filter(e => e.name !== ".git").map(e => ({ name: e.name, directory: e.isDirectory() }));
    case "delete_file": await rm(await repositoryPath(root, a.path)); return { deleted: a.path };
    case "diff": return { diff: (await git(root, ["diff", "HEAD", "--"], token)).slice(0, 120_000), status: await git(root, ["status", "--short"], token) };
    case "checks": {
      const pr = await api(`pulls/${job.number}`); const sha = pr.head.sha;
      const [checks, workflows, statuses] = await Promise.all([api(`commits/${sha}/check-runs?per_page=100`), api(`actions/runs?head_sha=${sha}&per_page=100`), api(`commits/${sha}/status`)]);
      return { head: sha, base: { ref: pr.base.ref, sha: pr.base.sha }, state: pr.state, labels: pr.labels.map((l: any) => l.name),
        checks: checks.check_runs.map((r: any) => ({ id: r.id, name: r.name, status: r.status, conclusion: r.conclusion, url: r.details_url })),
        workflows: workflows.workflow_runs.map((r: any) => ({ id: r.id, name: r.name, status: r.status, conclusion: r.conclusion, head_sha: r.head_sha, attempt: r.run_attempt, url: r.html_url })),
        statuses: statuses.statuses.map((r: any) => ({ context: r.context, state: r.state, url: r.target_url })),
        incomplete: checks.total_count > checks.check_runs.length || workflows.total_count > workflows.workflow_runs.length };
    }
    case "jobs": {
      const result = await api(`actions/runs/${a.run_id}/jobs?per_page=100`);
      return { jobs: result.jobs.map((j: any) => ({ id: j.id, name: j.name, status: j.status, conclusion: j.conclusion, url: j.html_url })), incomplete: result.total_count > result.jobs.length };
    }
    case "logs": {
      const response = await fetch(`https://api.github.com/repos/${job.owner}/${job.repo}/actions/jobs/${a.job_id}/logs`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" } });
      if (!response.ok) throw new Error(`GitHub logs ${response.status}`);
      return { text: (await response.text()).slice(-32_000) };
    }
    case "sync_base": {
      const pr = await activePr();
      if ((await git(root, ["status", "--porcelain"], token)).trim()) throw new Error("Commit or resolve local edits before rebasing.");
      const refs = [`+refs/heads/${pr.base.ref}:refs/remotes/origin/${pr.base.ref}`, `+refs/pull/${job.number}/head:refs/remotes/origin/hillclimb-pr`];
      await git(root, ["fetch", "--unshallow", "origin", ...refs], token).catch(async () => { await git(root, ["fetch", "origin", ...refs], token); });
      try {
        const result = await git(root, ["rebase", pr.base.sha], token);
        const head = (await git(root, ["rev-parse", "HEAD"], token)).trim();
        return { result, head, remoteHead: pr.head.sha, rebased: head !== pr.head.sha, base: pr.base.ref };
      } catch (error) { return { conflicts: await git(root, ["diff", "--name-only", "--diff-filter=U"], token), error: String(error), base: pr.base.ref }; }
    }
    case "continue_rebase": {
      for (const path of a.paths) await repositoryPath(root, path);
      await git(root, ["add", "--", ...a.paths], token);
      // Suppress any interactive editor; commit messages are already present.
      await git(root, ["-c", "core.editor=true", "rebase", "--continue"], token);
      return { status: await git(root, ["status", "--short"], token) };
    }
    case "commit_push": {
      const pr = await activePr();
      if (pr.head.ref === pr.base.ref) throw new Error("Refusing to push the base branch.");
      const meta = await repositoryMeta(root);
      const localHead = (await git(root, ["rev-parse", "HEAD"], token)).trim();
      if (pr.head.sha !== meta.remoteHead && pr.head.sha !== localHead) throw new Error("The PR head changed externally; stop before overwriting another writer.");
      for (const path of a.paths) await repositoryPath(root, path);
      if (a.paths.length) await git(root, ["add", "--", ...a.paths], token);
      if ((await git(root, ["diff", "--cached", "--name-only"], token)).trim()) await git(root, ["commit", "-m", a.message], token);
      await git(root, ["push", `--force-with-lease=refs/heads/${pr.head.ref}:${pr.head.sha}`, "origin", `HEAD:refs/heads/${pr.head.ref}`], token);
      const head = (await git(root, ["rev-parse", "HEAD"], token)).trim();
      await writeFile(join(dirname(root), "repo-meta.json"), JSON.stringify({ remoteHead: head }));
      return { head, branch: pr.head.ref };
    }
    case "comment": {
      const marker = "<!-- codex-hillclimb -->";
      const comments = await api(`issues/${job.number}/comments?per_page=100`);
      const previous = comments.find((c: any) => c.body?.startsWith(marker) && c.user?.type === "Bot");
      const body = JSON.stringify({ body: `${marker}\n${a.body}` });
      return previous ? api(`issues/comments/${previous.id}`, { method: "PATCH", body }) : api(`issues/${job.number}/comments`, { method: "POST", body });
    }
    default: throw new Error("Unsupported repository tool");
  }
}
const server = new Server({ name: "hillclimb-repo", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  try { return { content: [{ type: "text", text: JSON.stringify(await invoke(req.params.name, req.params.arguments || {})) }] }; }
  catch (e) { return { isError: true, content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }] }; }
});
await server.connect(new StdioServerTransport());
