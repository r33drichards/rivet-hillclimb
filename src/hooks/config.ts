import { defineExtension, GenerationTask, hook, ToolTask } from "@earendil-works/pi-durable";
import { forwardComment } from "./forward-comment.js";

/** Edit registrations here to choose which native Pi events appear on the PR. */
export const progressCommentExtension = defineExtension({
  name: "hillclimb-pr-progress",
  hooks: [
    hook(ToolTask, {
      beforeTool: forwardComment("beforeTool"),
      afterTool: forwardComment("afterTool", {
        mode: "update",
        format: ({ toolName, outcome }) => `\`${toolName}\`: ${outcome === "error" ? "reported an error" : "completed"}.`,
      }),
    }),
    hook(GenerationTask, {
      onYield: forwardComment("onYield"),
      // Other native hooks can use the same adapter:
      // beforeRequest: forwardComment("beforeRequest"),
      // afterTools: forwardComment("afterTools", { mode: "append" }),
      // afterRun: forwardComment("afterRun"),
    }),
  ],
});
