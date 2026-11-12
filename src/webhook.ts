import { Hono } from "hono";
import { labelJob, githubSignal, verifyWebhook, type HillclimbJob, type GitHubSignal } from "./github.js";
export function githubWebhook(dispatch: (input: { kind: "label"; job: HillclimbJob } | { kind: "signal"; signal: GitHubSignal }) => Promise<unknown>) {
  const app = new Hono();
  app.get("/health", (c) => c.text("ok"));
  app.post("/github/webhook", async (c) => {
    const body = await c.req.text();
    if (!verifyWebhook(body, c.req.header("x-hub-signature-256") || "", process.env.GITHUB_WEBHOOK_SECRET || "")) {
      return c.text("invalid signature", 401);
    }
    let payload: unknown;
    try { payload = JSON.parse(body); } catch { return c.text("invalid JSON", 400); }
    const job = labelJob(c.req.header("x-github-event") || "", payload, c.req.header("x-github-delivery") || "");
    const signal = githubSignal(c.req.header("x-github-event") || "", payload, c.req.header("x-github-delivery") || "");
    if (!job && !signal) return c.body(null, 202);
    try {
      // receive only persists/schedules a job; it never waits for model inference.
      await dispatch(job ? { kind: "label", job } : { kind: "signal", signal: signal! });
      return c.json({ accepted: true }, 202);
    } catch {
      // Report failure so the delivery can be redelivered without losing work.
      return c.text("could not accept job", 503);
    }
  });
  return app;
}
