import { createHash } from "node:crypto";
import { defineDoc, type CompactionHooks, type GenerationHooks, type HookApi, type ToolHooks } from "@earendil-works/pi-durable";
import { createClient } from "rivetkit/client";
import { internalParams } from "../auth.js";

/** Set once by the actor before admitting a turn. No PR credentials enter Pi documents. */
export const ForwardCommentContext = defineDoc({
  kind: "hillclimb.forward-comment-context",
  version: 1,
  scope: "session",
  initial: () => ({ actorId: "" }),
  checkpointWhen: () => true,
});

export type NativeHooks = Pick<ToolHooks & GenerationHooks & CompactionHooks,
  "beforeTool" | "afterTool" | "afterTools" | "onYield" | "afterRun" | "beforeRequest" | "beforeCompact" | "afterResponse">;
export type ProgressEventName = keyof NativeHooks;
export interface ProgressComment {
  id: string;
  event: ProgressEventName;
  body: string;
  mode: "update" | "append";
}
/** Formatters receive this metadata only, never prompts, tool arguments, outputs, or reasoning. */
export interface SafeProgressEvent {
  event: ProgressEventName;
  taskId: number;
  conversationId: number;
  toolName?: string;
  outcome?: "success" | "error" | "answer" | "terminate";
  messageCount?: number;
  resultCount?: number;
  entryCount?: number;
  toolCount?: number;
}
export interface ForwardCommentOptions {
  mode?: ProgressComment["mode"];
  format?: (event: Readonly<SafeProgressEvent>) => string | undefined;
}

/** Canonicalize only for hashing. Neither the serialization nor its raw inputs are forwarded. */
function canonical(value: unknown, ancestors = new Set<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object") return `[${typeof value}]`;
  if (ancestors.has(value)) return "[circular]";
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map(item => canonical(item, ancestors));
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Record<string, unknown>)[key], ancestors)]));
  } finally { ancestors.delete(value); }
}
function nativeFingerprint(event: ProgressEventName, input: readonly unknown[]): unknown {
  const first = input[0] as any;
  const call = () => ({ id: first?.id, name: first?.name, arguments: first?.arguments, parent: first?.parent });
  const message = (value: any) => ({ role: value?.role, responseId: value?.responseId, stopReason: value?.stopReason,
    content: Array.isArray(value?.content) ? value.content.filter((block: any) => block?.type !== "thinking").map((block: any) => {
      if (block?.type === "text") return { type: "text", text: block.text };
      if (block?.type === "toolCall") return { type: "toolCall", id: block.id, name: block.name, arguments: block.arguments };
      return { type: block?.type };
    }) : value?.content });
  switch (event) {
    case "beforeTool": return call();
    case "afterTool": {
      const result = input[1] as any;
      return { call: call(), result: { isError: !!result?.isError, output: result?.output,
        structuredOutput: result?.structuredOutput, control: result?.control,
        diagnostics: Array.isArray(result?.diagnostics) ? result.diagnostics.map((d: any) => ({ code: d?.code, severity: d?.severity })) : [] } };
    }
    case "afterTools": return { assistant: first, results: input[1] };
    case "beforeRequest": return { messages: Array.isArray(first?.messages) ? first.messages.map(message) : [] };
    case "beforeCompact": return { reason: first?.reason, firstKept: first?.firstKept,
      entries: Array.isArray(first?.entries) ? first.entries.map((entry: any) => entry?.id) : [], instructions: first?.instructions };
    case "afterRun": return { reason: first?.reason, first: first?.first, answer: first?.answer, last: first?.last };
    case "onYield":
    case "afterResponse": return message(first);
  }
}
export function progressEventId(event: ProgressEventName, taskId: number, nativeInput: readonly unknown[]) {
  return createHash("sha256").update(event).update("\0").update(String(taskId)).update("\0")
    .update(JSON.stringify(canonical(nativeFingerprint(event, nativeInput)))).digest("hex");
}
const length = (value: unknown) => Array.isArray(value) ? value.length : 0;
const toolName = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,100}$/.test(value) ? value : "tool";
/** Kept explicit per native event so adding a hook cannot accidentally expose its payload. */
export function safeProgressEvent(event: ProgressEventName, input: readonly unknown[], api: Pick<HookApi, "taskId" | "conversationId">): Readonly<SafeProgressEvent> {
  const first = input[0] as any;
  const base: SafeProgressEvent = { event, taskId: Number(api.taskId), conversationId: Number(api.conversationId) };
  switch (event) {
    case "beforeTool": return Object.freeze({ ...base, toolName: toolName(first?.name) });
    case "afterTool": return Object.freeze({ ...base, toolName: toolName(first?.name), outcome: (input[1] as any)?.isError ? "error" : "success" });
    case "afterTools": return Object.freeze({ ...base, resultCount: length(input[1]) });
    case "beforeRequest": return Object.freeze({ ...base, messageCount: length(first?.messages) });
    case "beforeCompact": return Object.freeze({ ...base, messageCount: length(first?.messages), entryCount: length(first?.entries) });
    case "afterRun": return Object.freeze({ ...base, ...(first?.reason === "answer" || first?.reason === "terminate" ? { outcome: first.reason } : {}) });
    case "afterResponse": return Object.freeze({ ...base, toolCount: Array.isArray(first?.content) ? first.content.filter((block: any) => block?.type === "toolCall").length : 0 });
    case "onYield": return Object.freeze({ ...base, outcome: "answer" });
  }
}
export function formatProgressEvent(event: Readonly<SafeProgressEvent>): string {
  switch (event.event) {
    case "beforeTool": return `Starting tool \`${event.toolName}\`.`;
    case "afterTool": return `Tool \`${event.toolName}\` ${event.outcome === "error" ? "reported an error" : "completed"}.`;
    case "afterTools": return `Tool round completed (${event.resultCount} result${event.resultCount === 1 ? "" : "s"}).`;
    case "beforeRequest": return `Requesting the next model step (${event.messageCount} context messages).`;
    case "beforeCompact": return `Compacting context (${event.entryCount} entries).`;
    case "afterResponse": return `Model response received (${event.toolCount} tool call${event.toolCount === 1 ? "" : "s"}).`;
    case "onYield": return "Model answer ready.";
    case "afterRun": return `Model run finished${event.outcome === "terminate" ? " after a terminating tool round" : ""}.`;
  }
}

/**
 * An observational native Pi hook. Its only side effect is a short durable
 * enqueue to the owning actor. It never changes native hook decisions/results.
 */
export function forwardComment<K extends ProgressEventName>(name: K, options: ForwardCommentOptions = {}): NativeHooks[K] {
  const handler = async (...args: unknown[]) => {
    const api = args.at(-2) as HookApi;
    const context = args.at(-1) as Parameters<HookApi["memo"]>[2];
    const input = args.slice(0, -2);
    let client: ReturnType<typeof createClient> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = new AbortController();
    try {
      const target = await api.snapshot(ForwardCommentContext, context);
      if (!target?.actorId) return undefined;
      const event = safeProgressEvent(name, input, api);
      const body = (options.format || formatProgressEvent)(event);
      if (body === undefined) return undefined;
      const progress: ProgressComment = { id: progressEventId(name, event.taskId, input), event: name, body, mode: options.mode || "update" };
      client = createClient({ fetch: (url, init) => fetch(url, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, abort.signal]) : abort.signal }) });
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { abort.abort(); reject(new Error("progress enqueue deadline")); }, 3000);
      });
      await Promise.race([
        client.hillclimb.getForId(target.actorId, { params: internalParams() }).forwardProgress(progress),
        deadline,
      ]);
    } catch {
      // Do not copy exception messages: transport errors can contain URLs or payloads.
      console.warn("PR progress comment forwarding failed", { event: name });
    } finally {
      if (timer) clearTimeout(timer);
      abort.abort();
      if (client) await client.dispose().catch(() => undefined);
    }
    return undefined;
  };
  return handler as NativeHooks[K];
}
