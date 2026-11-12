import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { invokeRuntime } from "../src/runtime.js";
const exec = promisify(execFile);
test("cloned repository supports isomorphic-git, file edits, and process restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hillclimb-fixture-"));
  try {
    const repo = join(dir, "data/repo");
    await mkdir(repo, { recursive: true });
    await exec("git", ["init", "-b", "main"], { cwd: repo });
    await writeFile(join(repo, "hello.txt"), "before\n");
    await exec("git", ["add", "hello.txt"], { cwd: repo });
    await exec("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "fixture"], { cwd: repo });
    await exec("git", ["checkout", "-b", "feature"], { cwd: repo });
    await writeFile(join(repo, "hello.txt"), "feature\n");
    await exec("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-am", "feature"], { cwd: repo });
    await exec("git", ["checkout", "main"], { cwd: repo });
    await writeFile(join(repo, "hello.txt"), "base\n");
    await exec("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-am", "base"], { cwd: repo });
    await exec("git", ["checkout", "feature"], { cwd: repo });
    await symlink("/etc/passwd", join(repo, "escape"));
    await writeFile(join(dir, "data/repo-meta.json"), JSON.stringify({ remoteHead: "fixture" }));
    await exec("tar", ["-czf", join(dir, "snapshot.tgz"), "-C", dir, "data"]);
    const job = { deliveryId: "fixture", owner: "r33drichards", repo: "fixture", number: 1, installationId: 1, headSha: "fixture" };
    const options = { repository: { job, token: "" } };
    const first = await invokeRuntime(await readFile(join(dir, "snapshot.tgz")), "run_js", {
      code: "console.log(await git.currentBranch({fs,dir:REPO_DIR})); await fs.writeFile(REPO_DIR+'/hello.txt','after\\n'); console.log(await git.statusMatrix({fs,dir:REPO_DIR})); console.log(await mcp.callTool('repo','read_file',{path:'hello.txt'}));",
    }, options);
    assert.match(JSON.stringify(first.result), /feature/);
    assert.match(JSON.stringify(first.result), /after/);
    assert.equal((first.result as any).status, "completed", JSON.stringify(first.result));
    const inspect = await invokeRuntime(first.checkpoint, "run_js", { code: "try { await git.merge({fs,dir:REPO_DIR,ours:'HEAD',theirs:'main',dryRun:true,abortOnConflict:true,author:{name:'Test',email:'test@example.com'}}); } catch(e) { console.log({mergeConflict:e.name,data:e.data}); }" }, options);
    assert.match(JSON.stringify(inspect.result), /MergeConflict/);
    const second = await invokeRuntime(inspect.checkpoint, "run_js", { code: "console.log(await fs.readFile(REPO_DIR+'/hello.txt','utf8')); console.log(await git.statusMatrix({fs,dir:REPO_DIR}));" }, options);
    assert.equal((second.result as any).status, "completed", JSON.stringify(second.result));
    assert.match(JSON.stringify(second.result), /after/);
    const denied = await invokeRuntime(second.checkpoint, "run_js", { code: "await fs.readFile('/etc/passwd','utf8')" }, options);
    assert.equal((denied.result as any).status, "failed");
    const configWrite = await invokeRuntime(second.checkpoint, "run_js", { code: "await fs.writeFile(REPO_DIR+'/.git/config','unsafe')" }, options);
    assert.equal((configWrite.result as any).status, "failed");
    for (const path of ["/../repo-meta.json", "/escape"]) {
      const escaped = await invokeRuntime(second.checkpoint, "run_js", { code: `await fs.readFile(REPO_DIR+${JSON.stringify(path)},'utf8')` }, options);
      assert.equal((escaped.result as any).status, "failed", path);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
