import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { labelJob, verifyWebhook } from "../src/github.js";
import { githubWebhook } from "../src/webhook.js";
const payload = () => ({ action: "labeled", label: { name: "codex-hillclimb" }, repository: { name: "any-repo", owner: { login: "r33drichards" } }, sender: { login: "r33drichards" }, installation: { id: 123 }, pull_request: { number: 42, state: "open", head: { sha: "abc123" } } });
test("accepts an owner-applied PR label on any r33drichards repo", () => {
  assert.deepEqual(labelJob("pull_request", payload(), "delivery"), { deliveryId: "delivery", owner: "r33drichards", repo: "any-repo", number: 42, installationId: 123, headSha: "abc123" });
});
test("ignores unrelated labels, repositories, senders, events, and closed PRs", () => {
  for (const mutate of [
    (p: any) => p.label.name = "other", (p: any) => p.action = "synchronize",
    (p: any) => p.repository.owner.login = "other", (p: any) => p.sender.login = "other",
    (p: any) => p.pull_request.state = "closed", (p: any) => delete p.installation,
  ]) { const p = payload(); mutate(p); assert.equal(labelJob("pull_request", p, "id"), undefined); }
  assert.equal(labelJob("issues", payload(), "id"), undefined);
});
test("HMAC verification fails closed and detects modified bodies", () => {
  const body = JSON.stringify(payload());
  const signature = "sha256=" + createHmac("sha256", "secret").update(body).digest("hex");
  assert.equal(verifyWebhook(body, signature, "secret"), true);
  assert.equal(verifyWebhook(body + " ", signature, "secret"), false);
  assert.equal(verifyWebhook(body, signature, ""), false);
  assert.equal(verifyWebhook(body, "bad", "secret"), false);
});
test("webhook schedules before acknowledging, and reports enqueue failures", async () => {
  process.env.GITHUB_WEBHOOK_SECRET = "secret";
  const body = JSON.stringify(payload());
  const headers = { "x-hub-signature-256": "sha256=" + createHmac("sha256", "secret").update(body).digest("hex"), "x-github-event": "pull_request", "x-github-delivery": "id", "content-type": "application/json" };
  let accepted = 0;
  const app = githubWebhook(async () => { accepted++; });
  assert.equal((await app.request("/github/webhook", { method: "POST", headers, body })).status, 202);
  assert.equal(accepted, 1);
  assert.equal((await app.request("/github/webhook", { method: "POST", headers: { ...headers, "x-hub-signature-256": "bad" }, body })).status, 401);
  assert.equal(accepted, 1);
  const unavailable = githubWebhook(async () => { throw new Error("offline"); });
  assert.equal((await unavailable.request("/github/webhook", { method: "POST", headers, body })).status, 503);
});
