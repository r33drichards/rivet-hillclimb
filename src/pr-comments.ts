import { githubApi, type HillclimbJob } from "./github.js";
export const APP_BOT = "r33drichards-codex-hillclimb[bot]";
// A stable marker deduplicates webhook retries and updates only this app's comments.
export async function prComment(job: HillclimbJob, body: string, key = "status", api = githubApi) {
  const marker = `<!-- codex-hillclimb:${key} -->`;
  let previous: any;
  for (let page = 1; page <= 20; page++) {
    const comments = await api(job, `issues/${job.number}/comments?per_page=100&page=${page}`);
    previous = comments.find((c: any) => c.user?.login === APP_BOT && c.body?.startsWith(marker));
    if (previous || comments.length < 100) break;
  }
  return api(job, previous ? `issues/comments/${previous.id}` : `issues/${job.number}/comments`, {
    method: previous ? "PATCH" : "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ body: `${marker}\n${body}` }),
  });
}
