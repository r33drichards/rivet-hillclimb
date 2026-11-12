import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, mkdir, realpath, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { HillclimbJob } from "./github.js";
const exec = promisify(execFile);
export function gitEnv(token: string, home: string) {
  return { PATH: process.env.PATH || "/usr/bin:/bin", HOME: home, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ALLOW_PROTOCOL: "https", GIT_CONFIG_COUNT: "5", GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader", GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
    GIT_CONFIG_KEY_1: "core.hooksPath", GIT_CONFIG_VALUE_1: "/dev/null", GIT_CONFIG_KEY_2: "protocol.file.allow", GIT_CONFIG_VALUE_2: "never", GIT_CONFIG_KEY_3: "credential.helper", GIT_CONFIG_VALUE_3: "", GIT_CONFIG_KEY_4: "core.fsmonitor", GIT_CONFIG_VALUE_4: "false" };
}
export async function git(cwd: string, args: string[], token: string) {
  const result = await exec("git", args, { cwd, env: gitEnv(token, dirname(cwd)), timeout: 90_000, maxBuffer: 2 * 1024 * 1024 });
  return result.stdout;
}
export async function prepareRepository(data: string, job: HillclimbJob, token: string) {
  const repo = join(data, "repo");
  try { await lstat(join(repo, ".git")); return repo; } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  await git(data, ["clone", "--depth", "1", "--no-checkout", `https://github.com/${job.owner}/${job.repo}.git`, "repo"], token);
  await git(repo, ["fetch", "--depth", "1", "origin", `pull/${job.number}/head`], token);
  await git(repo, ["checkout", "--detach", "FETCH_HEAD"], token);
  await git(repo, ["config", "user.name", "Codex Hillclimb"], token);
  await git(repo, ["config", "user.email", "codex-hillclimb@users.noreply.github.com"], token);
  const head = (await git(repo, ["rev-parse", "HEAD"], token)).trim();
  await writeFile(join(data, "repo-meta.json"), JSON.stringify({ remoteHead: head }));
  return repo;
}
// Resolve every existing path component, rejecting both .git and links out of the clone.
export async function repositoryPath(root: string, relative: string) {
  if (!relative || relative.includes("\0") || relative.split(/[\\/]/).some(p => p === ".." || p.toLowerCase() === ".git") || relative.startsWith("/") || /^[a-z]:/i.test(relative)) throw new Error("Path must stay in the repository and cannot access .git.");
  const base = await realpath(root);
  const target = resolve(base, relative);
  if (target !== base && !target.startsWith(base + sep)) throw new Error("Path escapes repository.");
  let current = target;
  while (true) {
    try {
      const real = await realpath(current);
      if (real !== base && !real.startsWith(base + sep)) throw new Error("Symlink escapes repository.");
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      if (current === base) throw e;
      current = dirname(current);
    }
  }
  return target;
}
export async function writeRepositoryFile(root: string, path: string, content: string) {
  const target = await repositoryPath(root, path);
  if (Buffer.byteLength(content) > 2 * 1024 * 1024) throw new Error("File exceeds 2 MiB.");
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
}
export async function repositoryMeta(root: string): Promise<{ remoteHead: string }> {
  return JSON.parse(await readFile(join(dirname(root), "repo-meta.json"), "utf8"));
}
