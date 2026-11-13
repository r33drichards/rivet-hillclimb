import { defineDoc } from "@earendil-works/pi-durable";

/** The controller sets runId before submission; tools only write an intent for that run. */
export const CiWaitContext = defineDoc({
  kind: "hillclimb.ci-wait", version: 1, scope: "session",
  initial: () => ({ runId: "", request: null as null | { runId: string; id: string; head: string } }),
  checkpointWhen: () => true,
});
export interface WaitIntent { runId: string; id: string; head: string }
export interface WaitState { status: string; waitingHead: string | null; appliedWaitIntent?: string | null }
/** Called only for a terminal submission, including recovery after a controller restart. */
export function restoreCiWait(state: WaitState, runId: string, intent: WaitIntent | null): boolean {
  if (state.status === "cancelled" || !intent || intent.runId !== runId) return false;
  if (state.appliedWaitIntent !== intent.id) {
    state.waitingHead = intent.head;
    state.appliedWaitIntent = intent.id;
  }
  state.status = "waiting_ci";
  return true;
}

export function recordCiWait(doc: { runId: string; request: WaitIntent | null }, runId: string, callId: string, head: string): void {
  if (!runId || doc.runId !== runId) throw new Error("Hillclimb run changed");
  doc.request = { runId, id: `${runId}:${callId}`, head };
}
