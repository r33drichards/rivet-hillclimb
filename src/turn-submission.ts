import type { ConversationId, EntryId, EntryRecord, SubmissionId, SubmissionRecord } from "@earendil-works/pi-durable";

/** Only short receipt/history reads; never waits on a running model over HTTP. */
export interface TurnReader {
  submission: { status(id: SubmissionId): Promise<SubmissionRecord> };
  conversation: { entries(id: ConversationId, query: { minEntryId: EntryId; maxEntryId: EntryId }, limit: number): Promise<{ items: readonly EntryRecord[] }> };
}
export type TurnResult = { status: "pending" } | { status: "done"; text?: string } | { status: "unanswered"; reason: string };
export async function readTurnResult(client: TurnReader, id: SubmissionId): Promise<TurnResult> {
  const receipt = await client.submission.status(id);
  if (receipt.status !== "done" && receipt.status !== "unanswered") return { status: "pending" };
  if (receipt.status === "unanswered") return { status: "unanswered", reason: receipt.reason };
  if (receipt.type !== "input" && receipt.type !== "continue") return { status: "done" };
  const page = await client.conversation.entries(receipt.conversationId, { minEntryId: receipt.answer, maxEntryId: receipt.answer }, 1);
  const message = page.items[0]?.model?.[0];
  const text = message?.role === "assistant" ? message.content.map(block => block.type === "text" ? block.text : "").join("") : undefined;
  return { status: "done", text };
}
export function isTransportFailure(error: unknown) {
  return /HTTP request error|fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up|network error/i.test(error instanceof Error ? error.message : String(error));
}
