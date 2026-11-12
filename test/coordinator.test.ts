import { test } from "node:test";
import assert from "node:assert/strict";
import { createRepoCoordinator } from "../src/coordinator.js";
import { githubSignal, ciReady, type HillclimbJob } from "../src/github.js";

const job: HillclimbJob = { owner: "r33drichards", repo: "test", number: 1, deliveryId: "label", installationId: 1, headSha: "head" };
test("push is ignored, and partial CI is not ready", () => {
  assert.equal(githubSignal("push", { repository: { owner: { login: job.owner }, name: job.repo }, installation: { id: 1 }, after: "head" }, "push"), undefined);
  assert.equal(ciReady({ check_runs: [{ status: "completed" }, { status: "in_progress" }] }, { workflow_runs: [] }, { statuses: [] }), false);
  assert.equal(ciReady({ check_runs: [{ status: "completed" }] }, { workflow_runs: [{ status: "queued" }] }, { statuses: [] }), false);
  assert.equal(ciReady({ check_runs: [] }, { workflow_runs: [] }, { statuses: [] }), false);
});
test("coordinator only wakes for current-head terminal CI or confirmed new conflicts", async () => {
  let complete = false;
  let mergeable: boolean | null = true;
  let base = "base-1";
  const fakeApi = async (_job: HillclimbJob, path: string): Promise<any> => {
    if (path.startsWith("pulls/")) return { state: "open", head: { sha: "head" }, base: { sha: base }, labels: [{ name: "codex-hillclimb" }], mergeable };
    if (path.includes("check-runs")) return { check_runs: [{ status: complete ? "completed" : "in_progress" }] };
    if (path.includes("actions/runs")) return { workflow_runs: [{ status: complete ? "completed" : "in_progress" }] };
    return { statuses: [] };
  };
  const observed = { wakes: [] as { id: string; reason: string }[], visits: 0, waitingHead: "head" };
  const runner = { receive: async () => {}, status: async () => { observed.visits++; return { waitingHead: observed.waitingHead }; },
    wake: async (id: string, reason: string) => { observed.wakes.push({ id, reason }); } };
  const definition = createRepoCoordinator(fakeApi).config;
  // Mock only Rivet's transport/scheduler boundaries. Exercise the actual
  // persisted coordinator state and action handlers with GitHub event fixtures.
  const context: any = {
    state: { jobs: {}, queue: [], lastConflict: {}, nextProbeAt: 0 }, vars: { processing: false }, key: [job.owner, job.repo],
    schedule: { after: async () => "scheduled" }, log: { error: (e: unknown) => { throw new Error(JSON.stringify(e)); } },
    client: () => ({ hillclimb: { getOrCreate: () => runner } }),
  };
  const actions = definition.actions!;
  const receive = async (input: any) => { await actions.receive(context, input); await actions.drain(context); };
  const signal = (reason: "ci_completed" | "pr_changed", id: string, headSha = "head") => receive({ kind: "signal", signal: { owner: job.owner, repo: job.repo, installationId: 1, deliveryId: id, reason, headSha, number: 1 } });
  await receive({ kind: "label", job });
  await signal("ci_completed", "partial");
  assert.equal(observed.visits, 0, "partial CI must not even contact the runner");
  complete = true;
  await signal("ci_completed", "stale", "old-sha");
  assert.equal(observed.wakes.length, 0);
  await signal("ci_completed", "ready");
  assert.deepEqual(observed.wakes, [{ id: "ci:head", reason: "ci_completed" }]);
  mergeable = null;
  await signal("pr_changed", "unknown");
  assert.equal(observed.wakes.length, 1);
  mergeable = false;
  await signal("pr_changed", "conflict");
  await signal("pr_changed", "same-conflict");
  assert.equal(observed.wakes.length, 2, "one wake per head/base conflict pair");
  base = "base-2";
  await signal("pr_changed", "new-conflict");
  assert.equal(observed.wakes.length, 3);
});
