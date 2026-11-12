const base = process.env.HILLCLIMB_PUBLIC_URL;
if (!base || !base.startsWith("https://")) throw new Error("Set HILLCLIMB_PUBLIC_URL to the deployed HTTPS webhook origin.");
const manifest = {
  name: "r33drichards Codex Hillclimb",
  url: "https://github.com/r33drichards",
  description: "Runs a durable Rivet/mcp-js CI repair agent when r33drichards applies codex-hillclimb to a PR.",
  public: false,
  hook_attributes: { url: new URL("/github/webhook", base).href, active: true },
  default_permissions: { contents: "write", pull_requests: "write", issues: "write", actions: "read", checks: "read", statuses: "read", workflows: "write", metadata: "read" },
  default_events: ["pull_request", "workflow_run", "check_suite", "check_run", "status"],
};
console.log(JSON.stringify(manifest, null, 2));
