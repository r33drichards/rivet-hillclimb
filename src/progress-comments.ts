import { UserError } from "rivetkit";
import type { ProgressComment } from "./hooks/forward-comment.js";
import type { HillclimbJob } from "./github.js";
import { prComment } from "./pr-comments.js";
export interface ProgressState { progressQueue?: ProgressComment[]; progressSeen?: string[]; }
export function enqueueProgress(state: ProgressState, event: ProgressComment): boolean {
  if (!/^[a-f0-9]{64}$/.test(event.id) || typeof event.body !== "string" || !["update", "append"].includes(event.mode)) throw new UserError("Invalid progress event");
  state.progressQueue ||= [];
  state.progressSeen ||= [];
  if (state.progressSeen.includes(event.id) || state.progressQueue.some(e => e.id === event.id)) return false;
  if (event.mode === "update") {
    const replaced = state.progressQueue.filter(e => e.mode === "update");
    state.progressSeen = [...state.progressSeen, ...replaced.map(e => e.id)].slice(-1000);
    state.progressQueue = state.progressQueue.filter(e => e.mode !== "update");
  }
  state.progressQueue.push({ ...event, body: event.body.slice(0, 6000) });
  return true;
}
export async function deliverProgress(state: ProgressState, job: HillclimbJob, post = prComment): Promise<void> {
  const event = state.progressQueue?.[0];
  if (!event) return;
  await post(job, `**Hillclimb progress**\n\n${event.body}`, event.mode === "append" ? `progress-${event.id}` : "progress");
  state.progressSeen = [...(state.progressSeen || []), event.id].slice(-1000);
  // A newer event may have replaced this one while GitHub was responding.
  state.progressQueue = state.progressQueue!.filter(e => e.id !== event.id);
}
