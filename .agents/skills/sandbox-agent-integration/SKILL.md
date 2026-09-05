---
name: sandbox-agent-integration
description: Use when changing Catamorphic sandbox providers, workflow execution sandboxes, coding-agent providers, dev sandbox lifecycle, sandbox instrumentation, or agent file staging.
---

# Sandbox & Agent Integration

## Overview

`@catamorphic/sandbox` provides two core capabilities:

1. **Workflow execution**: runs workflow code through an injected sandbox or
   trusted local-process provider with persisted Run state and step-level
   observability.
2. **Coding-agent contract**: the vendor-neutral `CodingAgentProvider`
   interface. Implementations include `@catamorphic/ai-sdk`,
   `@catamorphic/claude-code`, and `@catamorphic/codex`. Hosts expose one
   provider or a dynamic `CodingAgentRegistry`.

## Provider Selection

Providers live in vendor plugin packages (see `docs/decisions/0004`, `0008`, and `CLOUDFLARE.md`); the host constructs its chosen backend explicitly at boot:

```typescript
import { CloudflareSandboxProvider } from "@catamorphic/cloudflare";
// Alternatives: @catamorphic/microsandbox, @catamorphic/daytona, or
// @catamorphic/local-process for a trusted single-tenant host.

const provider = new CloudflareSandboxProvider({
  apiUrl: process.env.CLOUDFLARE_SANDBOX_API_URL!,
  apiKey: process.env.CLOUDFLARE_SANDBOX_API_KEY,
});
```

Providers handed to `CatamorphicCore` are automatically wrapped with `instrumentSandboxProvider` (OpenTelemetry spans: `sandbox.create`, `sandbox.exec`, `sandbox.upload_files`, …). The wrapper preserves the optional `hydrateWorkspace` method (tar-based upload) that the Cloudflare provider exposes.

## Sandbox Model

Execution has two distinct purposes, but not every agent uses a sandbox:

- **Production deployment runtime** — Immutable code pinned to deployed
  `origin/main`; a warm supervisor accepts queued invocations for the artifact.
- **Agent checkout**: mutable project code selected per session. Controller
  agents edit a dev sandbox; native Claude Code or Codex agents can use a
  host-resolved local checkout through `nativeAgentCheckout`. Runs never
  execute these mutable files; every Run executes a deployed commit.

Logical project Environments and immutable Allocations select the execution
provider, resources, and connection grants. Project builder scope does not
imply Environment or connection authority.

## Package Structure

```
packages/sandbox/src/               -- vendor-neutral, no vendor SDKs
  types.ts                 -- provider, runtime, and coding-agent shared types
  instrumented-provider.ts -- instrumentSandboxProvider (OTel wrapper)
  sandbox-manager.ts       -- dev-sandbox lifecycle helper
  plugin-upload.ts         -- attached plugin materialization helper
  coding-agent/
    types.ts               -- CodingAgentProvider interface (extensible)
    plugin-staging.ts      -- stagedPluginFiles / buildPluginsPreamble helpers

packages/core/src/services/
  deployment-runtime-service.ts -- immutable warm execution runtimes
  execution-worker-service.ts   -- queued Run leasing and dispatch

packages/ai-sdk/src/                -- @catamorphic/ai-sdk coding-agent plugin (flagship)
  ai-sdk-agent.ts          -- AiSdkCodingAgent + sandbox-backed tools

packages/claude-code/src/            -- @catamorphic/claude-code harness
  claude-code-agent.ts      -- Claude Agent SDK adapter

packages/codex/src/                 -- @catamorphic/codex coding-agent plugin
  codex-agent.ts           -- CodexAgent (Codex SDK implementation)

packages/microsandbox/src/           -- local sandbox provider
packages/local-process/src/          -- trusted sandboxless subprocess provider

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

The host passes one provider or a `CodingAgentRegistry` to
`createCatamorphic({ hostId, codingAgent, sandboxProvider,
environmentProvider, nativeAgentCheckout? })`. A registry entry owns a stable
id, provider, topology, privilege ceiling, defaults, connection requirements,
and explicit delegation policy. Session orchestration, persistence, checkout
selection, serialized delivery, and checkpointing remain vendor-neutral in
`AgentSessionsService`.

```typescript
import { anthropic } from "@ai-sdk/anthropic";
import { AiSdkCodingAgent } from "@catamorphic/ai-sdk"; // flagship
// or: import { CodexAgent } from "@catamorphic/codex";

const agent = new AiSdkCodingAgent({
  model: anthropic("claude-sonnet-4-5"),
  sandboxProvider: provider, // tool loop runs on the host, edits happen in the sandbox
});
```

Do not model first-class delegated work with provider-only subagent events.
Agent definitions declare exact or constrained delegation routes and a child
concurrency limit. Core creates ordinary child sessions, keeps hierarchy
separate from fork lineage, and exposes spawn/list/wait/interrupt/attention
operations. Native provider delegation is only an adapter optimization when it
preserves that contract.

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
item/sink tables keyed by Run and workflow-step attempt. Agent sessions,
messages, hierarchy, delegation, archive visibility, attention, and ownership
are durable database state keyed by the host's stable `external_user_id`;
there is no Catamorphic users table or foreign key to a host user table.

## API Routes

- `POST /api/projects/:projectId/workflows/:name/runs` — Trigger a run (every run executes the deployed commit)
- `GET /api/projects/:projectId/workflows/:name/runs` — List runs for a Workflow
- `GET /api/runs/:runId` — Fetch run + steps
- `/api/runs/:runId/*` — Capability-driven cancel, processing pause/resume,
  input submission, and batch-scope item inspection
- `POST/GET/DELETE /api/projects/:projectId/agent/sessions[...]` — Agent sessions + messages (503 when no `codingAgent` configured)
- `POST|GET /api/projects/:projectId/agent/sessions/:sessionId/subsessions[...]`: Create, list, wait for, and interrupt first-class delegated sessions
- `POST /api/projects/:projectId/agent/sessions/:sessionId/archive|unarchive`: Recursively archive or restore a session tree; archive returns typed impact and may require confirmation
- `POST /api/projects/:projectId/agent/sessions/:sessionId/attention/acknowledge` — Clear the current workflow-requested attention revision
- `GET /api/projects/:projectId/skills` — List per-project agent skills

## Adding a New Coding Agent Provider

Implement the `CodingAgentProvider` interface:

```typescript
interface CodingAgentProvider {
  readonly name: string;
  startSession(opts: StartSessionOpts): Promise<ProviderSession>;
  sendMessage(
    session: ProviderSession,
    message: string,
    opts?: TurnOptions,
  ): AsyncIterable<AgentEvent>;
  interrupt?(providerSessionId: string): void;
  hasSession?(providerSessionId: string): boolean;
  retryTurn?(
    session: ProviderSession,
    opts?: TurnOptions & { sanitizeReasoning?: boolean },
  ): AsyncIterable<AgentEvent>;
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
