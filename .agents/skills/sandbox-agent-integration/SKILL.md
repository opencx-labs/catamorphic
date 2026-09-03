---
name: sandbox-agent-integration
description: Use when changing Catamorphic sandbox providers, workflow execution sandboxes, coding-agent providers, dev sandbox lifecycle, sandbox instrumentation, or agent file staging.
---

# Sandbox & Agent Integration

## Overview

`@catamorphic/sandbox` provides two core capabilities:

1. **Workflow Execution** — Runs workflow code inside sandboxes (Cloudflare Sandbox by default, Daytona as alternate) with persisted Run state and step-level observability
2. **Coding Agent contract** — the vendor-neutral `CodingAgentProvider` interface. Implementations are plugin packages: `@catamorphic/ai-sdk` (flagship — AI SDK tool loop runs on the host server and edits the dev sandbox remotely) and `@catamorphic/codex` (Codex SDK). See `docs/decisions/0009` and `0018`.

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

## Sandbox Model

Each project uses two distinct sandbox types:

- **Production deployment runtime** — Immutable code pinned to deployed
  `origin/main`; a warm supervisor accepts queued invocations for the artifact.
- **Dev sandbox** — Per-user, mutable code for coding agents. Keyed by
  `(project_id, user_id)`. Runs never execute dev files; every run executes a
  deployed commit.

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

packages/ai-sdk/src/                -- @catamorphic/ai-sdk coding-agent plugin (flagship)
  ai-sdk-agent.ts          -- AiSdkCodingAgent + sandbox-backed tools

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
  supervisor-protocol.ts   -- Deployment invocation and event protocol
  supervisor-http.ts       -- Warm runtime HTTP supervisor
  supervisor-worker.ts     -- Per-invocation Bun Worker execution
  supervisor-dispatcher.ts -- Workflow/boundary/batch dispatch
```

## Sandbox Manager

```typescript
import { SandboxManagerImpl } from "@catamorphic/sandbox";

const manager = new SandboxManagerImpl({ provider, store: dbStore });

// Deployment runtime sandbox for a specific commit
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
import { anthropic } from "@ai-sdk/anthropic";
import { AiSdkCodingAgent } from "@catamorphic/ai-sdk"; // flagship
// or: import { CodexAgent } from "@catamorphic/codex";

const agent = new AiSdkCodingAgent({
  model: anthropic("claude-sonnet-4-5"),
  sandboxProvider: provider, // tool loop runs on the host, edits happen in the sandbox
});
```

Per-project skills live in the project repo under `.agents/skills/<name>/SKILL.md` (Agent Skills layout, `docs/decisions/0010`); the agent reads relevant skills from the sandbox checkout with its filesystem tools. `core.skills.list(...)` / `GET /api/projects/:id/skills` enumerate them.

Project agents may declare provider-neutral connection requirements in
`agents/<slug>.json`. A workflow that wakes that agent should also declare the
same aliases in its own `connections` array so the member reviews and
authenticates everything needed before enabling unattended execution. MCP
credentials use the same connection broker and are sufficient when the server
exposes the required actions.

`catamorphic.sessions.wake` creates or reuses a stable member-owned session,
then queues a normal agent turn through `AgentSessionsService`; it does not run
an agent inside the workflow sandbox. The session still receives ordinary
Environment admission, allocation, connection admission, tool-policy
narrowing, serialized turn delivery, and checkpointing. A settled requested
turn increments server-owned attention state. Opening it calls
`POST /api/projects/:projectId/agent/sessions/:sessionId/attention/acknowledge`.

## Runtime Harness

The plain-workflow test harness runs inside a disposable directory in the dev
sandbox via `bun run harness.ts`. It:

1. Installs the call-site step recorder used by parser-transformed source.
2. Imports the requested workflow file and executes its exported function.
3. Emits one safely serialized `CATAMORPHIC_REPORT:` JSON line on stdout.

Production Runs are enqueued in Postgres. A host explicitly starts
`catamorphic.startExecutionWorker(...)`; the worker advances the canonical Run
through plain execution or ordered `defineBoundary`/`defineBatch` scopes. The
deployment supervisor reports sequenced events, while Postgres remains
authoritative for retries, pauses, child Runs, batch items, cancellation, and
terminal state.

Environment variables:
- `CATAMORPHIC_RUN_ID` — Run ID
- `CATAMORPHIC_WORKFLOW_NAME` — Function name to execute
- `CATAMORPHIC_WORKFLOW_FILE` — Project-relative workflow source path
- `CATAMORPHIC_TRIGGER_DATA` — JSON trigger payload

## Database Tables

Every invocation persists one canonical `workflow_runs` row. Supporting tables
include `workflow_run_states`, `workflow_step_attempts`, `workflow_pauses`,
`workflow_run_steps`, `workflow_run_events`, `execution_jobs`, and batch-scope
item/sink tables keyed by Run and workflow-step attempt. Migration `008`
introduced `project_sandboxes`, `agent_sessions`, and `agent_messages`, keyed by
host `external_user_id`; there is no Catamorphic users table.

## API Routes

- `POST /api/projects/:projectId/workflows/:name/runs` — Trigger a run (every run executes the deployed commit)
- `GET /api/projects/:projectId/workflows/:name/runs` — List runs for a Workflow
- `GET /api/runs/:runId` — Fetch run + steps
- `/api/runs/:runId/*` — Capability-driven cancel, processing pause/resume,
  input submission, and batch-scope item inspection
- `POST/GET/DELETE /api/projects/:projectId/agent/sessions[...]` — Agent sessions + messages (503 when no `codingAgent` configured)
- `POST /api/projects/:projectId/agent/sessions/:sessionId/attention/acknowledge` — Clear the current workflow-requested attention revision
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
- `S3RemoteBackend` (`@catamorphic/s3`) — Default git origin for R2, S3,
  MinIO, and compatible stores until Artifacts is generally available

The host chooses by constructing the backend it wants and passing it via `createCatamorphic({ storage })` — there is no env-var switch.
