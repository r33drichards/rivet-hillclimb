import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const client = new Client({ name: "smoke", version: "1" });
try {
  await client.connect(new StdioClientTransport({ command: "node", args: ["--env-file=.env", "--import", "tsx", "src/mcp-bridge.ts"] }));
  assert.equal((await client.listTools()).tools[0].name, "run_js");
  const result = await client.callTool({ name: "run_js", arguments: { code: "console.log(6 * 7)" } });
  assert.equal(result.isError, false);
  assert.match(JSON.stringify(result), /42/);
  console.log("PASS: MCP client -> stdio bridge -> Rivet actor -> mcp-js -> 42");
} finally { await client.close(); }
