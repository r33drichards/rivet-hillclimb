import { test } from "node:test";
import assert from "node:assert/strict";
import { githubSignal, type HillclimbJob } from "../src/github.js";
import { createRepoCoordinator } from "../src/coordinator.js";
import { prComment, APP_BOT } from "../src/pr-comments.js";
const job: HillclimbJob = { owner: "r33drichards", repo: "test", number: 1, deliveryId: "label", installationId: 1, headSha: "head" };
const payload = { repository: { owner: { login: job.owner }, name: job.repo }, installation: { id: 1 }, sender: { login: job.owner }, action: "created", issue: { number: 1, pull_request: {} }, comment: { id: 22, user: { login: job.owner, type: "User" }, body: "/hillclimb focus on the flaky test" } };
test("only new owner commands on PRs are accepted; bots/edits/ordinary comments ignored", () => {
  assert.equal(githubSignal("issue_comment", payload, "event")?.message, "focus on the flaky test");
  for (const p of [ { ...payload, action: "edited" }, { ...payload, sender: { login: "other" } }, { ...payload, issue: { number: 1 } }, { ...payload, comment: { ...payload.comment, body: "ordinary comment" } }, { ...payload, comment: { ...payload.comment, user: { login: job.owner, type: "Bot" } } } ]) assert.equal(githubSignal("issue_comment", p, "event"), undefined);
  const pr = { ...payload, action: "unlabeled", label: { name: "codex-hillclimb" }, pull_request: { number: 1 } };
  assert.equal(githubSignal("pull_request", pr, "remove")?.reason, "cancel");
  assert.equal(githubSignal("pull_request", { ...pr, label: { name: "other" } }, "other")?.reason, "pr_changed");
});
test("unlabel cancels tracked runner, stale unlabel cannot cancel relabeled PR, owner commands deduplicate", async () => {
  let labeled = true;
  let stopped = false;
  const calls: string[] = [];
  const replies: string[] = [];
  const api = async () => ({ state: "open", labels: labeled ? [{ name: "codex-hillclimb" }] : [], head: { sha: "head" }, base: { sha: "base" }, mergeable: true });
  const runner = { receive: async () => {}, cancel: async () => { calls.push("cancel"); stopped = true; }, status: async () => ({ job, status: stopped ? "cancelled" : "waiting_ci", waitingHead: "head", lastError: null }), wake: async (...args: any[]) => { calls.push(args[0]); } };
  const actions = createRepoCoordinator(api, async (_job, body) => { replies.push(body); }).config.actions!;
  const c: any = { key: [job.owner, job.repo], state: { jobs: {}, queue: [], lastConflict: {}, nextProbeAt: 0, handledSignals: [] }, vars: { processing: false }, schedule: { after: async () => "id" }, client: () => ({ hillclimb: { getOrCreate: () => runner } }), log: { error: (e: any) => { throw Error(JSON.stringify(e)); } } };
  const deliver = async (signal: any) => { await actions.receive(c, { kind: "signal", signal: { ...job, ...signal } }); await actions.drain(c); };
  await actions.receive(c, { kind: "label", job }); await actions.drain(c);
  await deliver({ reason: "cancel", deliveryId: "old-unlabel" });
  assert.equal(calls.length, 0);
  labeled = false;
  await deliver({ reason: "cancel", deliveryId: "unlabel" });
  assert.deepEqual(calls, ["cancel"]);
  assert.deepEqual(c.state.jobs, {});
  await deliver({ reason: "cancel", deliveryId: "unlabel" });
  assert.deepEqual(calls, ["cancel"], "redelivery cannot recancel a new run");
  labeled = true; stopped = false;
  await actions.receive(c, { kind: "label", job: { ...job, deliveryId: "relabel" } }); await actions.drain(c);
  await deliver({ reason: "comment", deliveryId: "comment-event", commentId: 22, message: "fix flaky test" });
  await deliver({ reason: "comment", deliveryId: "redelivery", commentId: 22, message: "fix flaky test" });
  assert.deepEqual(calls, ["cancel", "comment:22"]);
  await deliver({ reason: "comment", deliveryId: "status", commentId: 23, message: "status" });
  assert.match(replies.at(-1)!, /waiting_ci/);
  await deliver({ reason: "comment", deliveryId: "stop", commentId: 24, message: "stop" });
  assert.equal(stopped, true);
  assert.deepEqual(c.state.jobs, {});
  await deliver({ reason: "comment", deliveryId: "stopped", commentId: 25, message: "more fixes" });
  assert.match(replies.at(-1)!, /re-add/);
});
test("status comments update only this app's marker, including beyond first page", async () => {
  let mutation: any;
  const fake = async (_job: HillclimbJob, path: string, init?: RequestInit): Promise<any> => {
    if (init) { mutation = { path, ...init }; return {}; }
    if (path.endsWith("page=1")) return Array.from({ length: 100 }, () => ({ id: 1, user: { login: "another-bot[bot]" }, body: "<!-- codex-hillclimb:status -->" }));
    return [{ id: 200, user: { login: APP_BOT }, body: "<!-- codex-hillclimb:status --> old" }];
  };
  await prComment(job, "cancelled", "status", fake);
  assert.equal(mutation.path, "issues/comments/200");
  assert.equal(mutation.method, "PATCH");
  assert.match(JSON.parse(mutation.body).body, /cancelled/);
});
