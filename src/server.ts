import { hillclimbRepo } from "./coordinator.js";
import { serve } from "@hono/node-server";
import { githubWebhook } from "./webhook.js";
import { hillclimb } from "./hillclimb.js";
import { createRegistry, defineExtension, defineTool } from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";
import { pi } from "@rivet-dev/pi";
import { setup, type Registry } from "rivetkit";
import { createClient } from "rivetkit/client";
import { authorize, internalParams } from "./auth.js";
import { mcpJs } from "./mcp-actor.js";
import { chatgptLogin } from "./chatgpt-login.js";
import { credentials } from "./credentials.js";

const tools = createRegistry();
tools.install(defineExtension({ name: "mcp-js", tools: [defineTool({
  name: "run_js",
  description: "Run JavaScript in your durable V8 session. Global variables persist across calls. Use console.log to show results. Network, filesystem, subprocesses, and module imports are disabled. Prefer this tool for calculations and data transformations.",
  parameters: obj({ code: str() }),
  executionMode: "sequential",
  replay: "safe",
  execute: async ({ code }, api) => {
    const client = createClient<Registry<{ mcpJs: typeof mcpJs }>>();
    const result = await client.mcpJs.getOrCreate([api.env!.id, String(api.conversationId)], { params: internalParams() })
      .callTool("run_js", { code }, api.callId);
    return { output: [{ type: "text" as const, text: JSON.stringify(result) }] };
  },
})] }));

export const agent = pi({
  model: process.env.AGENT_MODEL || "openai/gpt-6-sol",
  registry: tools,
  onBeforeConnect: authorize,
  credentials: (c) => c.client<Registry<{ credentials: typeof credentials }>>()
    .credentials.getOrCreate([c.key[0]], { params: internalParams() }),
});
export const registry = setup({ use: { mcpJs, credentials, chatgptLogin, agent, hillclimb, hillclimbRepo } });
if (process.env.GITHUB_WEBHOOK_SECRET) {
  const client = createClient<typeof registry>();
  const app = githubWebhook((input) => {
    const target = input.kind === "label" ? input.job : input.signal;
    return client.hillclimbRepo.getOrCreate([target.owner, target.repo], { params: internalParams() }).receive(input);
  });
  if (process.env.RIVETKIT_RUNTIME_MODE === "serverless") {
    // Use the same native listener as start(), adding the webhook fallback.
    // Rivet continues to own /api/rivet and its actor lifecycle endpoints.
    void registry.listen({ application: app }).catch((error) => {
      console.error("Rivet HTTP listener failed", error);
      process.exit(1);
    });
  } else {
    registry.start();
    serve({ fetch: app.fetch, port: Number(process.env.GITHUB_WEBHOOK_PORT || 8080), hostname: "0.0.0.0" });
  }
} else registry.start();
