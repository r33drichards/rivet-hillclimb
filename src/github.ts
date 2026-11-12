import { createHmac, timingSafeEqual } from "node:crypto";
import { createAppAuth } from "@octokit/auth-app";
export const GITHUB_OWNER = "r33drichards";
export const TRIGGER_LABEL = "codex-hillclimb";
export interface HillclimbJob {
  deliveryId: string; owner: string; repo: string; number: number;
  installationId: number; headSha: string;
}
export function verifyWebhook(body: string, signature: string, secret: string) {
  if (!secret || !/^sha256=[0-9a-f]{64}$/.test(signature)) return false;
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`);
  const actual = Buffer.from(signature);
  return actual.length === expected.length && timingSafeEqual(expected, actual);
}
export function labelJob(event: string, payload: any, deliveryId: string): HillclimbJob | undefined {
  if (event !== "pull_request" || payload?.action !== "labeled" || payload?.label?.name !== TRIGGER_LABEL) return;
  if (payload.repository?.owner?.login?.toLowerCase() !== GITHUB_OWNER) return;
  if (payload.sender?.login?.toLowerCase() !== GITHUB_OWNER) return;
  const pr = payload.pull_request;
  if (pr?.state !== "open" || !pr.head?.sha || !Number.isInteger(pr.number) || pr.number < 1) return;
  if (!/^[A-Za-z0-9_.-]+$/.test(payload.repository?.name || "") || !deliveryId || !Number.isInteger(payload.installation?.id)) return;
  return { deliveryId, owner: GITHUB_OWNER, repo: payload.repository.name, number: pr.number,
    installationId: payload.installation.id, headSha: pr.head.sha };
}
export async function githubToken(job: HillclimbJob): Promise<string> {
  const appId = process.env.GITHUB_APP_ID;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (!appId || !privateKey) throw new Error("Configure GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY before starting hillclimb.");
  const auth = createAppAuth({ appId, privateKey });
  const result = await auth({ type: "installation", installationId: job.installationId,
    repositoryNames: [job.repo], permissions: { contents: "write", pull_requests: "write", issues: "write", actions: "read", checks: "read", workflows: "write", statuses: "read" } });
  return result.token;
}
export async function githubApi(job: HillclimbJob, path: string, init: RequestInit = {}) {
  const token = await githubToken(job);
  const response = await fetch(`https://api.github.com/repos/${job.owner}/${job.repo}/${path}`, {
    ...init, headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28", ...init.headers },
  });
  if (!response.ok) throw new Error(`GitHub ${response.status} on ${path}`);
  return response.json();
}

export type WakeReason = "ci_completed" | "conflicts";
export interface GitHubSignal { owner: string; repo: string; deliveryId: string; installationId: number; reason: "ci_completed" | "pr_changed"; headSha?: string; number?: number; }
export function githubSignal(event: string, p: any, deliveryId: string): GitHubSignal | undefined {
  if (p?.repository?.owner?.login?.toLowerCase() !== GITHUB_OWNER || !/^[A-Za-z0-9_.-]+$/.test(p.repository?.name || "") || !Number.isInteger(p.installation?.id) || !deliveryId) return;
  const common = { owner: GITHUB_OWNER, repo: p.repository.name, deliveryId, installationId: p.installation.id };
  if (event === "push") return; // Our own pushes never wake the runner.
  const completed = event === "workflow_run" ? p.action === "completed" : ["check_suite", "check_run"].includes(event) ? p.action === "completed" : event === "status" && ["success", "failure", "error"].includes(p.state);
  if (completed) {
    const headSha = p.workflow_run?.head_sha || p.check_suite?.head_sha || p.check_run?.head_sha || p.sha;
    if (typeof headSha === "string") return { ...common, reason: "ci_completed", headSha };
  }
  if (event === "pull_request" && ["synchronize", "edited", "reopened", "unlabeled", "closed"].includes(p.action) && Number.isInteger(p.pull_request?.number)) {
    return { ...common, reason: "pr_changed", number: p.pull_request.number };
  }
}
export function ciReady(checks: any, workflows: any, statuses: any) {
  const runs = checks.check_runs || [];
  const actions = workflows.workflow_runs || [];
  const contexts = statuses.statuses || [];
  if ((checks.total_count || 0) > runs.length || (workflows.total_count || 0) > actions.length) return false;
  const hasResults = runs.length + actions.length + contexts.length > 0;
  return hasResults && runs.every((r: any) => r.status === "completed") && actions.every((r: any) => r.status === "completed") && contexts.every((r: any) => r.state !== "pending");
}
