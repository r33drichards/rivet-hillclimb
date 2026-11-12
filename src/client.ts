import { createInterface } from "node:readline/promises";
import { createClient } from "rivetkit/client";
import type { registry } from "./server.js";
const client = createClient<typeof registry>(process.env.CLIENT_RIVET_ENDPOINT || "http://127.0.0.1:6420");
const userId = process.env.USER_ID || "owner";
const params = { authToken: process.env.APP_ACCESS_TOKEN! };
const [command, ...words] = process.argv.slice(2);
try {
  if (command === "login") {
    const login = client.chatgptLogin.getOrCreate([userId], { params });
    const url = await login.start();
    console.log(`Open this URL to sign in with ChatGPT:\n${url}\n`);
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    const redirect = await terminal.question("Paste the complete redirect URL from your browser: ");
    terminal.close();
    await login.finish(redirect.trim() || undefined);
    console.log("ChatGPT sign-in saved.");
  } else if (command === "chat") {
    const result = await client.agent.getOrCreate([userId, "chat"], { params }).prompt(words.join(" "));
    console.log(JSON.stringify(result, null, 2));
  } else if (command === "run") {
    const result = await client.mcpJs.getOrCreate([userId, "manual"], { params }).callTool("run_js", { code: words.join(" ") });
    console.log(JSON.stringify(result, null, 2));
  } else {
    throw new Error("Usage: npm run client -- login | chat <prompt> | run <javascript>");
  }
} finally { await client.dispose(); }
