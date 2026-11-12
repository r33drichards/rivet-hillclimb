import { actor, type Registry } from "rivetkit";
import { authorize, internalParams } from "./auth.js";
import type { hillclimb } from "./hillclimb.js";
import { ciReady, githubApi, GITHUB_OWNER, TRIGGER_LABEL, type HillclimbJob, type GitHubSignal } from "./github.js";

export function createRepoCoordinator(api = githubApi) {
return actor({
  state: { jobs: {} as Record<string, HillclimbJob>, queue: [] as ({ kind: "label"; job: HillclimbJob } | { kind: "signal"; signal: GitHubSignal })[],
    lastConflict: {} as Record<string, string>, nextProbeAt: 0 },
  createVars: () => ({ processing: false }),
  onBeforeConnect: authorize,
  options: { sleepTimeout: 5_000, actionTimeout: 120_000 },
  onWake: async (c) => {
    if (c.state.queue.length) await c.schedule.after(0, "drain");
    if (Object.keys(c.state.jobs).length && c.state.nextProbeAt <= Date.now()) await c.schedule.after(0, "probe");
  },
  actions: {
    status: (c) => ({ queued: c.state.queue.length, tracking: Object.keys(c.state.jobs) }),
    receive: async (c, input: { kind: "label"; job: HillclimbJob } | { kind: "signal"; signal: GitHubSignal }) => {
      const target = input.kind === "label" ? input.job : input.signal;
      if (target.owner !== GITHUB_OWNER || c.key.join("/") !== `${target.owner}/${target.repo}`) throw new Error("Repository mismatch");
      c.state.queue.push(input);
      await c.schedule.after(0, "drain");
    },
    drain: async (c): Promise<void> => {
      if (c.vars.processing) return;
      c.vars.processing = true;
      const client = c.client<Registry<{ hillclimb: typeof hillclimb }>>();
      try {
        while (c.state.queue.length) {
          const entry = c.state.queue[0];
          if (entry.kind === "label") {
            const job = entry.job;
            c.state.jobs[String(job.number)] = job;
            await client.hillclimb.getOrCreate([job.owner, job.repo, String(job.number)], { params: internalParams() }).receive(job);
          } else {
            const signal = entry.signal;
            for (const job of Object.values(c.state.jobs)) {
              if (signal.reason === "pr_changed" && signal.number !== job.number) continue;
              const pr = await api(job, `pulls/${job.number}`);
              if (pr.state !== "open" || !pr.labels.some((l: { name: string }) => l.name === TRIGGER_LABEL)) { delete c.state.jobs[String(job.number)]; continue; }
              if (signal.reason === "ci_completed" && signal.headSha === pr.head.sha) {
                const runner = client.hillclimb.getOrCreate([job.owner, job.repo, String(job.number)], { params: internalParams() });
                const [checks, workflows, statuses] = await Promise.all([
                  api(job, `commits/${pr.head.sha}/check-runs?per_page=100`),
                  api(job, `actions/runs?head_sha=${pr.head.sha}&per_page=100`),
                  api(job, `commits/${pr.head.sha}/status`),
                ]);
                if (ciReady(checks, workflows, statuses)) {
                  const state = await runner.status();
                  if (state.waitingHead === pr.head.sha) await runner.wake(`ci:${pr.head.sha}`, "ci_completed");
                }
              }
              if (pr.mergeable === false) {
                const conflict = `${pr.head.sha}:${pr.base.sha}`;
                if (c.state.lastConflict[String(job.number)] !== conflict) {
                  c.state.lastConflict[String(job.number)] = conflict;
                  await client.hillclimb.getOrCreate([job.owner, job.repo, String(job.number)], { params: internalParams() }).wake(`conflict:${conflict}`, "conflicts");
                }
              }
            }
          }
          c.state.queue.shift();
        }
      } catch (error) {
        c.log.error({ message: "GitHub event processing failed; retrying", error: String(error) });
        await c.schedule.after(30_000, "drain");
      } finally {
        c.vars.processing = false;
        if (Object.keys(c.state.jobs).length && c.state.nextProbeAt <= Date.now()) {
          c.state.nextProbeAt = Date.now() + 60_000;
          await c.schedule.after(60_000, "probe");
        }
      }
    },
    probe: async (c): Promise<void> => {
      // Only this lightweight coordinator wakes on a timer. The model runner and
      // mcp-js workspace stay asleep unless CI is ready or a conflict is confirmed.
      c.state.nextProbeAt = 0;
      for (const job of Object.values(c.state.jobs)) {
        c.state.queue.push({ kind: "signal", signal: { owner: job.owner, repo: job.repo, installationId: job.installationId,
          deliveryId: `probe:${job.number}:${Date.now()}`, reason: "pr_changed", number: job.number } });
      }
      await c.schedule.after(0, "drain");
    },
  },
});

}
export const hillclimbRepo = createRepoCoordinator();
