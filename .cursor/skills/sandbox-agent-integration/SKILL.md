# Sandbox & Agent Integration

## Overview

`@catamorphic/sandbox` provides two core capabilities:

1. **Workflow Execution** — Runs workflow code inside sandboxes (Cloudflare Sandbox by default, Daytona as alternate) with step-level observability
2. **Coding Agent contract** — the vendor-neutral `CodingAgentProvider` interface. Implementations are plugin packages: `@catamorphic/flue` (flagship — harness runs on the host server, edits the dev sandbox remotely) and `@catamorphic/codex` (Codex SDK). See `docs/decisions/0009`.

## Provider Selection

Providers live in vendor plugin packages (see `docs/decisions/0004`, `0008`, and `CLOUDFLARE.md`); the host constructs its chosen backend explicitly at boot:

```typescript
import { CloudflareSandboxProvider } from "@catamorphic/cloudflare"; // default
// or: import { DaytonaSandboxProvider } from "@catamorphic/daytona";

const provider = new CloudflareSandboxProvider({
  apiUrl: process.env.CLOUDFLARE_SANDBOX_API_URL!,
  apiKey: process.env.CLOUDFLARE_SANDBOX_API_KEY,
});
```

Providers handed to `CatamorphicCore` are automatically wrapped with `instrumentSandboxProvider` (OpenTelemetry spans: `sandbox.create`, `sandbox.exec`, `sandbox.upload_files`, …). The wrapper preserves the optional `hydrateWorkspace` method (tar-based upload) that the Cloudflare provider exposes.

## Two-Sandbox Model

Each project uses two distinct sandbox types:

- **Execution Sandbox** — Pinned to a commit SHA, immutable code, for running workflows. Keyed by `(project_id, commit_sha)`.
- **Dev Sandbox** — Per-user, mutable code, for the coding agent. Keyed by `(project_id, user_id)`.

## Package Structure

```
packages/sandbox/src/               -- vendor-neutral, no vendor SDKs
  types.ts                 -- SandboxProvider, SandboxManager, RunExecutor, CloneSource interfaces
  instrumented-provider.ts -- instrumentSandboxProvider (OTel wrapper)
  sandbox-manager.ts       -- SandboxManagerImpl (two-sandbox lifecycle)
  run-executor.ts          -- RunExecutorImpl (execute workflows via sandbox; clone or upload)
  coding-agent/
    types.ts               -- CodingAgentProvider interface (extensible)
    plugin-staging.ts      -- stagedPluginFiles / buildPluginsPreamble helpers

packages/flue/src/                  -- @catamorphic/flue coding-agent plugin (flagship)
  flue-agent.ts            -- FlueCodingAgent (server-side Flue harness)
  sandbox-adapter.ts       -- catamorphicSandbox (Flue SandboxFactory over SandboxProvider)

packages/codex/src/                 -- @catamorphic/codex coding-agent plugin
  codex-agent.ts           -- CodexAgent (Codex SDK implementation)

packages/cloudflare/src/            -- @catamorphic/cloudflare plugin
  sandbox-provider.ts      -- CloudflareSandboxProvider (HTTP client to the Bridge Worker)
  artifacts-client.ts      -- ArtifactsClient (Artifacts REST: repos + scoped tokens)
  artifacts-remote-backend.ts -- ArtifactsRemoteBackend (RemoteBackend + getCloneSource)

packages/daytona/src/               -- @catamorphic/daytona plugin
  sandbox-provider.ts      -- DaytonaSandboxProvider (Daytona SDK wrapper)
  storage-backend.ts       -- DaytonaBackend (StorageBackend using Daytona sandboxes)
  project-repo.ts          -- DaytonaProjectRepo (ProjectRepo using Daytona's git/fs APIs)

packages/cloudflare-sandbox-bridge/  -- deployable Worker the Cloudflare provider talks to

packages/runtime/src/
  harness.ts               -- Entry point that runs inside sandbox
  step-wrapper.ts          -- Source-level instrumentation of "use step" functions
  reporter.ts              -- Reports run results to Catamorphic API
  types.ts                 -- StepEntry, RunReport types
```

## Sandbox Manager

```typescript
import { SandboxManagerImpl } from "@catamorphic/sandbox";

const manager = new SandboxManagerImpl({ provider, store: dbStore });

// Execution sandbox for a specific commit
const execSandbox = await manager.ensureExecSandbox({
  projectId: "...",
  commitSha: "abc123...",
});

// Dev sandbox for a user
const devSandbox = await manager.ensureDevSandbox({
  projectId: "...",
  userId: "...",
});
```

## Coding Agent

The host picks an agent at boot and passes it to `createCatamorphic({ codingAgent })`. Session orchestration (dev sandbox lifecycle, persistence, sync-back of agent edits into the user's draft) is vendor-neutral in `core.agentSessions` (`AgentSessionsService`).

```typescript
import { FlueCodingAgent } from "@catamorphic/flue"; // flagship
// or: import { CodexAgent } from "@catamorphic/codex";

const agent = new FlueCodingAgent({
  model: "openai/gpt-5.2-codex",
  sandboxProvider: provider, // harness runs on the host, edits happen in the sandbox
});
```

Per-project skills live in the project repo under `.agents/skills/<name>/SKILL.md` (Agent Skills layout, `docs/decisions/0010`); Flue discovers them from the sandbox checkout automatically. `core.skills.list(...)` / `GET /api/projects/:id/skills` enumerate them.

## Runtime Harness

The harness runs inside the sandbox via `bun run harness.ts`. It:

1. Scans project source for `"use step"` functions
2. Wraps each step with instrumentation (input, output, timing, errors)
3. Executes the workflow function with trigger data
4. Emits a `CATAMORPHIC_REPORT:` JSON line on stdout, parsed by the server (the `POST /api/runs/:runId/report` push route exists but is not implemented yet)

Environment variables:
- `CATAMORPHIC_RUN_ID` — Run ID
- `CATAMORPHIC_WORKFLOW_NAME` — Function name to execute
- `CATAMORPHIC_TRIGGER_DATA` — JSON trigger payload
- `CATAMORPHIC_API_URL` — API base URL for reporting
- `CATAMORPHIC_COMMIT_SHA` — Commit SHA being executed

## Database Tables

Runs persist to `workflow_runs` + `workflow_run_steps`. Migration `008` (re)introduced `project_sandboxes` (dev sandbox tracking per project + external user), `agent_sessions`, and `agent_messages` — all keyed by `external_user_id` (host identity), no `users` table.

## API Routes

- `POST /api/projects/:projectId/workflows/:name/runs` — Trigger a run (synchronous today)
- `GET /api/runs/:runId` — Fetch run + steps
- `POST /api/playground/run` — Test run from the editor (503 when no provider configured)
- `POST/GET/DELETE /api/projects/:projectId/agent/sessions[...]` — Agent sessions + messages (503 when no `codingAgent` configured)
- `GET /api/projects/:projectId/skills` — List per-project agent skills

## Adding a New Coding Agent Provider

Implement the `CodingAgentProvider` interface:

```typescript
interface CodingAgentProvider {
  readonly name: string;
  startSession(opts: StartSessionOpts): Promise<ProviderSession>;
  resumeSession(providerSessionId: string): Promise<ProviderSession>;
  sendMessage(session: ProviderSession, message: string): AsyncIterable<AgentEvent>;
  dispose(session: ProviderSession): Promise<void>;
}
```

## Storage Backend Selection

- `FsBackend` / `FsRemoteBackend` (`@catamorphic/git`) — Local dev, CI, tests, simple hosts (default)
- `ArtifactsRemoteBackend` (`@catamorphic/cloudflare`) — Cloudflare Artifacts remotes; implements `getCloneSource()` so sandboxes `git clone` with a short-lived token instead of receiving uploads
- `DaytonaBackend` (`@catamorphic/daytona`) — Uses Daytona sandboxes as Git repo storage (experimental)

The host chooses by constructing the backend it wants and passing it via `createCatamorphic({ storage })` — there is no env-var switch.
