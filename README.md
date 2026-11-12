# Durable PR hillclimb on Rivet

A `codex-hillclimb` label applied by **r33drichards** starts a CI repair agent for a PR in any repository owned by **r33drichards**. Each PR has a durable agent actor and an mcp-js actor containing its cloned Git repository. The agent runs an OpenAI model through Rivet Pi, edits code using JavaScript, `fs`, and installed `isomorphic-git`, pushes focused fixes, and uses GitHub Actions as its test feedback.

The agent's instructions live directly in [prompts/hillclimb.md](prompts/hillclimb.md). They were adapted from the local cloud project's hillclimb workflow. No skill loader or separate skill installation is used.

## Current status

The local implementation passes TypeScript checks, HMAC/webhook tests, wake-decision tests, repository edit/restart tests, and an isomorphic-git merge-conflict test. The original actor persistence, idle sleep/wake, retry receipt, and stdio MCP bridge checks were also verified locally.

**Cloud deployment succeeds through GitHub Actions.** The first Actions run built, pushed, and deployed in about five minutes. The app health endpoint returns 200 at https://durablejs-wwiv-durablejs-wwiv-d-6yr5.rivet.run/api/rivet/health. The CLI still receives the exact requested `--namespace durablejs-wwiv-durablejs-wwiv-d-8xoj`; Rivet resolved that display name to namespace ID `durablejs-wwiv-d-6yr5`, whose engine namespace/hostname is `durablejs-wwiv-durablejs-wwiv-d-6yr5`. The originally supplied hostname ending in `8xoj` returns 404. PRs run tests; pushes to `main` test, build, push, deploy, and verify health. Credentials live in Actions secrets, not source. RivetKit is pinned to 2.3.31 for serverless support.

The private GitHub App is installed on all current and future r33drichards repositories (App ID 5725876, installation 181185920), and its signing key is configured locally. Its signed webhook is active at `https://durablejs-wwiv-durablejs-wwiv-d-6yr5.rivet.run/github/webhook`; GitHub installation deliveries return 202. Subscriptions are `pull_request`, `check_run`, `check_suite`, `status`, and `workflow_run`; `push` is excluded. ChatGPT sign-in completed with the Apple-linked account, renewable OAuth credentials are saved in the local credentials actor, and a live model call returned `connected`. These local credentials have not been transferred to a cloud deployment. Cloud ChatGPT sign-in is still required before labeled PRs can run inference.

## Sleep and wake behavior

1. A signed `pull_request.labeled` event with the exact label `codex-hillclimb`, applied by r33drichards, reaches `/github/webhook`.
2. The receiver durably schedules work in a lightweight repository coordinator and returns HTTP 202 without waiting for inference.
3. The PR runner restores its conversation and mcp-js workspace, diagnoses CI, edits files, and pushes a focused change.
4. It calls `wait_for_ci` with the new head SHA and ends the turn. The runner and workspace actors sleep after five seconds of inactivity.
5. GitHub completion events reach the coordinator. It verifies the current PR head and that all observed checks/workflows are terminal before waking the runner. Stale SHA and partial completion events do not contact the runner.
6. The coordinator checks mergeability once per minute while a labeled PR is tracked. Only `mergeable === false` wakes a conflict-resolution turn, once per head/base pair. Unknown mergeability or a moved base alone does not wake inference.

**`push` is never subscribed to or used as a wake trigger.** PR metadata changes may request a conflict check, but the runner's own push cannot start another model turn by itself. A completion check immediately after saving a wait closes the race where CI finishes before the actor records its waiting head.

The coordinator's brief mergeability checks use no model or workspace. It sleeps between scheduled probes. This is necessary because GitHub does not provide a dedicated "merge conflicts appeared" webhook.

## mcp-js repository environment

`run_js` has native `fs`, `REPO_DIR`, and the vendored isomorphic-git 1.27.1 integration from the upstream mcp-js NixOS test. The library is served only over an ephemeral loopback module URL allowed by an exact module policy. Filesystem policy and a path guard confine file operations to the restored repository clone, reject parent traversal, and prevent following links out of it.

Examples:

```js
console.log(await fs.readFile(REPO_DIR + '/src/example.ts', 'utf8'));
await fs.writeFile(REPO_DIR + '/src/example.ts', 'replacement source\n');
console.log(await git.statusMatrix({ fs, dir: REPO_DIR }));
console.log(await mcp.callTool('repo', 'checks', {}));
```

The `repo` MCP backend provides bounded file helpers, diffs, GitHub Actions checks/jobs/logs, fetch/rebase, continuation of resolved rebases, lease-protected commits/pushes, and an idempotent PR-summary comment. It obtains a short-lived GitHub App token scoped to the single repository. The token is not embedded in Git remote URLs or placed in the clone. Direct internet access and arbitrary subprocesses are not exposed to agent code. Trusted backend helpers invoke Git; no local project builds or tests run in the worker.

Every successful call closes the mcp-js process and checkpoints the heap, clone, and Git metadata to actor SQLite. Checkpoint generations are uploaded in small chunks; a small atomic pointer/receipt transaction commits the new generation. An interrupted write leaves the previous generation valid. Larger clones favor correctness over throughput in this first implementation.

## Local development

`.env` contains private app credentials, the stable ChatGPT host ID, local mcp-v8 binary path, and cloud endpoint. It is excluded from Git and Docker context. Preserve the host ID across deployments.

```sh
npm ci
npm run dev
# Another terminal:
npm run client -- run 'globalThis.counter = 41; console.log(counter)'
npm run client -- run 'counter += 1; console.log(counter)'
npm run client -- login
npm run client -- chat 'Use run_js to calculate 6 * 7.'
```

`login` prints a ChatGPT consent URL and asks for the final redirect URL. Complete it for `HILLCLIMB_USER_ID` (default `owner`) so automated PR runners can use that operator's ChatGPT login. This uses Rivet Pi with an OpenAI model; it does not launch a separate Codex CLI.

`.codex/config.toml` connects this workspace's local `rivet_js` MCP bridge. It was called successfully from this chat. Keep the local server running to use it. After a working cloud deployment, set `CLIENT_RIVET_ENDPOINT` to `CLOUD_RIVET_ENDPOINT` in `.env` to use cloud actors.

## GitHub installation

The private [r33drichards Codex Hillclimb App](https://github.com/settings/installations/181185920) is installed on **all repositories** so existing and future repositories are covered. Creation, key generation, and installation were completed through the browser and API access was verified against r33drichards/mcp-js. A manifest generator is prepared:

```sh
HILLCLIMB_PUBLIC_URL=https://<deployed-webhook-origin> node scripts/github-app-manifest.mjs
```

Requested repository permissions are Contents/Pull requests/Issues write, Actions/Checks/Commit statuses read, Workflows write (for CI workflow fixes), and Metadata read. Subscribe to `pull_request`, `workflow_run`, `check_suite`, `check_run`, and `status`; do not subscribe to `push`.

Configure `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, and `GITHUB_WEBHOOK_SECRET` on the worker. Set `GITHUB_WEBHOOK_PORT` to the port exposed by the container's public HTTP ingress. The endpoint is `https://<public-origin>/github/webhook`. Signature verification is mandatory, including before processing a label event. The App credentials are configured in the private local `.env`. Public ingress and event subscriptions are active; the signing secret is configured in both GitHub and Actions secrets.

The initial version supports PR branches in the installed repository. Fork branches need an additional authorized write strategy and currently report a blocker.

## Deploy

Once Rivet resolves the registry rejection:

```sh
export RIVET_CLOUD_TOKEN='<cloud API token>'
npm run deploy
```

The script always passes `--namespace durablejs-wwiv-durablejs-wwiv-d-8xoj` and `--env PORT=3000`. No other namespace is a deployment target. Keep `registry.start()`; Compute supplies serverless runtime configuration. The old local `CLOUD_RIVET_ENDPOINT` is not passed to deployment.

The Docker image includes mcp-v8 v0.22.0, the system prompt, and the offline isomorphic-git bundle. The deploy script passes configured GitHub secrets, the app access token, ChatGPT host ID, and issued ChatGPT client ID. It requests 2 GiB memory for repository/heap snapshots, limits the pool to eight concurrent actors, and retains scale-to-zero defaults. The cloud API deploy token is not copied into the image or given to agent code.

## Validation

```sh
npm run check
MCP_V8_BINARY="$PWD/.local/bin/mcp-v8" npm test
# With npm run dev running:
npm run test:actor
node --import tsx test/bridge-smoke.ts
```

The automated tests exercise actual mcp-v8 execution and the coordinator's production handlers with mocked GitHub/transport boundaries. A live GitHub label → Actions run → sleeping actor → resumed model cycle remains unverified until deployment, App installation, and model sign-in are available.

Repository-mode calls have a 120-second execution limit, 256 MiB V8 heap, 64 KB returned console output, and a 128 MiB compressed checkpoint cap. Plain calculator sessions retain a 15-second timeout, 8 MiB heap, and 32 MiB checkpoint cap. Commit history and execution history accumulate; retention/object-storage optimization is still needed for sustained large workloads. This uses V8/process isolation, not an E2B VM.

No Cargo commands were run. For Rust source changes in `mcp-js/`, use its Nix flake (`nix develop --command cargo ...`).

References: [Rivet GitHub connector](https://rivet.dev/guides/connect-github/), [sandbox code mode](https://rivet.dev/guides/sandbox-code-mode/), [ChatGPT sign-in](https://rivet.dev/guides/sign-in-with-chatgpt/), [GitHub webhook events](https://docs.github.com/en/webhooks/webhook-events-and-payloads).
