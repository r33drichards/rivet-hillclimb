import { prComment } from "./pr-comments.js";
import { actor, type Registry } from "rivetkit";
import { authorize, internalParams } from "./auth.js";
import type { hillclimb } from "./hillclimb.js";
import { ciReady, githubApi, GITHUB_OWNER, TRIGGER_LABEL, type HillclimbJob, type GitHubSignal } from "./github.js";

export function createRepoCoordinator(api = githubApi, comment = prComment) {
return actor({
  state: { jobs: {} as Record<string, HillclimbJob>, queue: [] as ({ kind: "label"; job: HillclimbJob } | { kind: "signal"; signal: GitHubSignal })[],
    lastConflict: {} as Record<string, string>, handledSignals: [] as string[], nextProbeAt: 0 },
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
            c.state.handledSignals ||= [];
            const signalId = signal.reason === "comment" ? `comment:${signal.commentId}` : signal.deliveryId;
            if (c.state.handledSignals.includes(signalId)) { c.state.queue.shift(); continue; }
            if ((signal.reason === "cancel" || signal.reason === "comment") && signal.number) {
              const job: HillclimbJob = c.state.jobs[String(signal.number)] || { ...signal, number: signal.number, headSha: "" };
              const runner = client.hillclimb.getOrCreate([job.owner, job.repo, String(job.number)], { params: internalParams() });
              if (signal.reason === "cancel") {
                const pr = await api(job, `pulls/${job.number}`);
                // An old unlabeled/closed delivery must not cancel a newer relabel/reopen.
                if (pr.state === "open" && pr.labels.some((l: { name: string }) => l.name === TRIGGER_LABEL)) {
                  c.state.handledSignals = [...c.state.handledSignals.slice(-499), signalId];
                  c.state.queue.shift(); continue;
                }
                delete c.state.jobs[String(job.number)];
                delete c.state.lastConflict[String(job.number)];
                await runner.cancel("Trigger label removed or PR closed");
              } else {
                const command = signal.message!.toLowerCase();
                if (command === "stop" || command === "cancel") {
                  delete c.state.jobs[String(job.number)];
                  await runner.cancel("Stopped by PR comment");
                  await comment(job, "Hillclimb stopped. Re-add `codex-hillclimb` to restart.", `reply-${signal.commentId}`, api);
                } else if (command === "status") {
                  const state = await runner.status();
                  await comment(job, `Hillclimb: **${state.status}**${state.waitingHead ? `; awaiting CI for \`${state.waitingHead}\`` : ""}.${state.lastError ? `\n\n${state.lastError}` : ""}`, `reply-${signal.commentId}`, api);
                } else {
                  const pr = await api(job, `pulls/${job.number}`);
                  const state = await runner.status();
                  if (pr.state !== "open" || !pr.labels.some((l: { name: string }) => l.name === TRIGGER_LABEL) || state.status === "cancelled" || !state.job) {
                    await comment(job, `Add (or remove and re-add) \`${TRIGGER_LABEL}\` to start hillclimb before sending instructions.`, `reply-${signal.commentId}`, api);
                  } else {
                    await comment(job, "Instruction received; I’ll respond here after processing it.", `reply-${signal.commentId}`, api);
                    await runner.wake(`comment:${signal.commentId}`, "comment", signal.message, signal.commentId);
                  }
                }
              }
              c.state.handledSignals = [...c.state.handledSignals.slice(-499), signalId];
              c.state.queue.shift();
              continue;
            }
            for (const job of Object.values(c.state.jobs)) {
              if (signal.number && signal.number !== job.number) continue;
              const pr = await api(job, `pulls/${job.number}`);
              if (pr.state !== "open" || !pr.labels.some((l: { name: string }) => l.name === TRIGGER_LABEL)) { delete c.state.jobs[String(job.number)]; await client.hillclimb.getOrCreate([job.owner, job.repo, String(job.number)], { params: internalParams() }).cancel("PR closed or trigger label removed"); continue; }
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
