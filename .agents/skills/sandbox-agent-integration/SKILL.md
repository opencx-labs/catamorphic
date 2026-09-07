---
name: sandbox-agent-integration
description: Use when changing Catamorphic sandbox providers, workflow execution sandboxes, coding-agent providers, Environment placement, server instance enrollment, dev sandbox lifecycle, sandbox instrumentation, or agent file staging.
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

For local/remote placement, read
[ADR 0098](../../../docs/decisions/0098-project-authorized-local-and-remote-agents.md).
Managed machines are instances of one shared-Postgres authority under
[ADR 0099](../../../docs/decisions/0099-shared-postgres-server-environments.md).
Instance ownership is distinct from authority identity. An Allocation must select
the actual process, workspace, tools, and recovery owner; recording an Environment
without routing execution does not implement placement. Keep member-device
execution authenticated to the authority without distributing Postgres credentials.
Stock nodes register renewable leases; their session branches persist before turn
completion. The SDK client runner executes sandbox operations on a member device
while the model and credential broker remain server-side. Never advertise native
CLI support through this controller transport. Follow the [setup reference](../../../skills/setup-catamorphic-server/references/cluster-deployment.md).

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
- `ObjectRemoteBackend` (`@catamorphic/git`) with `S3ObjectStore` (`@catamorphic/s3`) — Default git origin for R2, S3,
  MinIO, and compatible stores until Artifacts is generally available

The host chooses by constructing the backend it wants and passing it via `createCatamorphic({ storage })` — there is no env-var switch.

## Native harness model catalogs

The desktop discovers models on demand through the selected harness and its
credential context. Claude Code uses `supportedModels`; Codex uses
`@catamorphic/codex`'s `listCodexModels` over the installed executable's
app-server `initialize` / `model/list` protocol. The TypeScript turn SDK has no
model-list method. Do not invoke the unsupported `codex debug models` command
or maintain a hardcoded model catalog. Discovery must bound process lifetime,
follow pagination, filter hidden models, clean up listeners/processes, and
report errors in the picker without starting a turn.

## Resource admission and lifecycle

Follow [ADR 0100](../../../docs/decisions/0100-workspace-resource-admission.md).
Managed allocations reserve workspace slots and CPU/memory atomically under a
node row lock. They own one sandbox each. Never return capacity until physical
cleanup succeeds, and never treat heartbeat expiry as proof that a VM stopped.
Keep cleanup independent of heartbeat renewal. Preserve the operator recovery
path for ambiguous creation/destruction outcomes.

`CreateSandboxOpts.resources` contains hard limits. Providers advertise
`resourceLimits` and reject unsupported limits; passing admission without passing
limits to creation is a bug. Resource requirements also travel through client
runner RPC. Report the real provider isolation, including on member devices.
Controller model loops run outside their sandbox and require host headroom.
Native CLI paths do not acquire sandbox limits by declaring them in JSON.

Check the public cluster reference when provisioning: microsandbox for isolated
remote development, subprocesses only for trusted single-tenant work. Confirm
actual VM CPU/memory, concurrent admission races, cleanup failures, session
archive/restore, and worker fencing. Preserve per-allocation files and credentials
when reviewing warm-runtime reuse.

## Harness and monitor lifecycle

For harness capability changes, follow [ADR 0101](../../../docs/decisions/0101-harness-capabilities-and-session-monitors.md).
Retain native file/shell/media capabilities within the selected permission mode;
replace private todos, delegation, and monitors only when the host provides the
corresponding session tools. Audit both provider adapters and AgentRuntime paths.
Verify the pinned executable with a loopback model/MCP fixture when changing CLI
flags, tool names, skill discovery, cwd, or resume behavior. SDK type comments are
not sufficient evidence of the CLI's error/retry behavior. Never use real model
credentials for a deterministic protocol test.

Use ordinary scheduled workflow IO for a temporary periodic check. Use a Monitor
provider when a shared external source should emit normalized Project Events.
Watcher source must be authored in `ProjectManager.openEphemeral`, never a fake
user's `openDev`: a host path resolver can map all users to the same real folder.
Dispose temporary checkouts and media on failure as well as success. Stop future
activations at session close/archive or expiry, retain refs needed by live runs,
and abort and join polling before closing the database.
