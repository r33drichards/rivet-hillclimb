import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createClient } from "rivetkit/client";
import type { registry } from "./server.js";
const client = createClient<typeof registry>(process.env.CLIENT_RIVET_ENDPOINT || "http://127.0.0.1:6420");
const handle = client.mcpJs.getOrCreate([process.env.USER_ID || "owner", process.env.MCP_SESSION || "codex"], {
  params: { authToken: process.env.APP_ACCESS_TOKEN! },
});
const server = new Server({ name: "rivet-mcp-js", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{
  name: "run_js",
  description: "Execute JavaScript in a durable V8 session hosted by a Rivet actor. Use globalThis for state across calls and console.log for output. Network, filesystem, subprocess, and module access are disabled.",
  inputSchema: { type: "object", properties: { code: { type: "string" } }, required: ["code"], additionalProperties: false },
}] }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== "run_js" || typeof request.params.arguments?.code !== "string") {
    return { isError: true, content: [{ type: "text", text: "Expected run_js with a code string." }] };
  }
  try {
    const result = await handle.callTool("run_js", { code: request.params.arguments.code }, crypto.randomUUID());
    return { isError: result.status !== "completed", content: [{ type: "text", text: JSON.stringify(result) }] };
  } catch (error) {
    return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
  }
});
server.onclose = () => { void client.dispose(); };
await server.connect(new StdioServerTransport());
