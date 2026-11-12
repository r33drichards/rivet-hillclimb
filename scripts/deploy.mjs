import { loadEnvFile } from "node:process";
import { spawnSync } from "node:child_process";
try { loadEnvFile(".env"); } catch (error) { if (error.code !== "ENOENT") throw error; }
if (!process.env.RIVET_CLOUD_TOKEN) throw new Error("Set RIVET_CLOUD_TOKEN to the cloud API token.");
for (const name of ["APP_ACCESS_TOKEN", "CHATGPT_HOST_ID"]) {
  if (!process.env[name]) throw new Error(`Missing ${name} in .env`);
}
const extra = [];
for (const key of ["GITHUB_WEBHOOK_SECRET", "GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", "GITHUB_WEBHOOK_PORT", "HILLCLIMB_USER_ID", "CHATGPT_CLIENT_ID"]) {
  if (process.env[key]) extra.push("--env", `${key}=${process.env[key]}`);
}
const result = spawnSync("npx", ["-y", "@rivetkit/cli", "deploy", "--yes", "--token", process.env.RIVET_CLOUD_TOKEN,
  "--namespace", "durablejs-wwiv-durablejs-wwiv-d-8xoj", "--env", "PORT=3000", "--env", `APP_ACCESS_TOKEN=${process.env.APP_ACCESS_TOKEN}`,
  "--env", `CHATGPT_HOST_ID=${process.env.CHATGPT_HOST_ID}`, "--memory", "2Gi", "--max-concurrent-actors", "8", ...extra], { stdio: "inherit" });
process.exit(result.status ?? 1);
