---
name: sandbox-agent-integration
description: Use when changing sandbox providers, workflow execution runtimes, coding-agent harnesses (ai-sdk, claude-code, codex), the coding-agent registry, Environment placement and Allocations, managed-machine enrollment, dev sandboxes, workspace resource admission, sandbox instrumentation, or plugin/agent file staging.
---

# Sandbox and agent integration

Two vendor-neutral contracts live in `@catamorphic/sandbox` (no vendor SDKs):

- `SandboxProvider` (`src/types.ts`): where workflow code and controller-agent
  commands execute.
- `CodingAgentProvider` (`src/coding-agent/types.ts`): a coding-agent harness.

Hosts construct concrete providers explicitly at boot and pass them to
`createCatamorphic`. There is no env-var switch inside the libraries.

## Where things live

| Concern | Path |
| --- | --- |
| Provider, runtime, resource types | `packages/sandbox/src/types.ts`, `execution-environment.ts` |
| OTel wrapper | `packages/sandbox/src/instrumented-provider.ts` |
| Warm deployment runtimes | `packages/sandbox/src/command-deployment-runtime.ts` (HTTP supervisor), `stdio-deployment-runtime.ts` |
| Harness contract and helpers | `packages/sandbox/src/coding-agent/` (`types.ts`, `plugin-staging.ts`, `tool-policy.ts`, `runtime-provider.ts`, `runtime-conformance.ts`) |
| Supervisor inside the runtime | `packages/runtime/src/` (`supervisor-http.ts`, `supervisor-stdio.ts`, `supervisor-dispatcher.ts`, `bun-worker.ts`) |
| Core services | `packages/core/src/services/`: `deployment-runtime-service.ts`, `execution-worker-service.ts`, `dev-sandbox-service.ts`, `execution-environments-service.ts`, `execution-allocations-service.ts`, `worker-nodes-service.ts`, `client-runners-service.ts`, `coding-agent-registry.ts`, `agent-sessions-service.ts`, `agent-capabilities-service.ts` |
| Harnesses | `packages/ai-sdk` (`AiSdkCodingAgent`), `packages/claude-code` (`ClaudeCodeAgent`), `packages/codex` (`CodexAgent`) |
| Providers | `packages/microsandbox` (desktop default), `packages/local-process` (trusted single-tenant, ADR 0047), `packages/cloudflare` (+ `packages/cloudflare-sandbox-bridge` Worker), `packages/daytona` |

## Sandbox providers

```typescript
import { MicrosandboxSandboxProvider } from "@catamorphic/microsandbox";
// or LocalProcessSandboxProvider, CloudflareSandboxProvider, DaytonaSandboxProvider

const sandboxProvider = new MicrosandboxSandboxProvider({ image: "oven/bun" });
createCatamorphic({ sandboxProvider, environmentProvider, /* ... */ });
```

- `CatamorphicCore` wraps every provider with `instrumentSandboxProvider`
  (`sandbox.create`, `sandbox.exec`, `sandbox.runtime.*`, ...). Never wrap it
  yourself. The wrapper forwards `workspaceRoot`, `isolation`,
  `resourceLimits`, `deploymentRuntime`, and the optional `hydrateWorkspace`
  (Cloudflare tar upload); forward any new optional member the same way.
- `deploymentRuntime` is the warm-runtime capability. Cloudflare and Daytona
  use `CommandDeploymentRuntimeProvider`; local-process and microsandbox use
  `StdioDeploymentRuntimeProvider`.
- A new provider reports its real `isolation` (`none | process | sandbox`) and
  lists enforceable `resourceLimits`. It must reject `CreateSandboxOpts.resources`
  it cannot enforce rather than ignore them.
- `environmentProvider` is required. `defineStaticEnvironments` (server-sdk)
  maps Environment descriptors to providers; see `INTEGRATION.md`.

## Workflow execution

- Every Run executes an immutable deployed commit. There is no mutable-source
  or test mode.
- The deployment runtime materializes the verified `.catamorphic/` capability
  snapshot (ADR 0142), installs its workspace dependencies, and applies the
  parser transform to that copy only. Plugin payloads land under
  `node_modules/<packageName>/` via `uploadPluginPayloads`.
- Runs are queued in Postgres. The host starts
  `catamorphic.startExecutionWorker(...)` explicitly. Postgres stays
  authoritative for retries, pauses, child Runs, batch items, cancellation,
  and terminal state; the supervisor only reports sequenced events.
- The supervisor forks one Bun child per invocation (`bun-worker.ts`) with
  `CATAMORPHIC_RUN_ID`, `CATAMORPHIC_WORKFLOW_NAME`, `CATAMORPHIC_WORKFLOW_FILE`,
  and `CATAMORPHIC_TRIGGER_DATA`. Providers that support persistent local data
  set `CATAMORPHIC_APP_DATA_DIR`; it is absent otherwise.
- Tables: `workflow_runs` (one per invocation), `workflow_run_states`,
  `workflow_step_attempts`, `workflow_pauses`, `workflow_run_steps`,
  `workflow_run_events`, `execution_jobs`, plus batch item/sink tables.

## Agent checkouts

Agents edit mutable code that Runs never execute. Controller agents
(ai-sdk) edit a dev sandbox managed by `DevSandboxService` (which uses
`SandboxManagerImpl` internally). Native harnesses (Claude Code, Codex) can use a
host-resolved local checkout through `createCatamorphic({ nativeAgentCheckout })`.

## Coding-agent harnesses

`createCatamorphic({ hostId, codingAgent })` accepts one `CodingAgentProvider`
or a `CodingAgentRegistry` (`packages/core/src/services/coding-agent-registry.ts`).
`hostId` is required when `codingAgent` is set; without `codingAgent`, session
routes answer 503. A `RegisteredCodingAgent` carries `id`, `provider`,
`topology`, `privilege`, `environment`, `connectionRequirements`, `defaults`,
`systemPrompt`, and `delegation`. Session orchestration, persistence, checkout
selection, serialized delivery, and checkpointing stay in
`AgentSessionsService`, never in a harness.

```typescript
import { AiSdkCodingAgent } from "@catamorphic/ai-sdk";

const agent = new AiSdkCodingAgent({ model, sandboxProvider, resolveModel });
```

To add a harness, implement `CodingAgentProvider`: `startSession` (no model
call), `sendMessage` (an `AsyncIterable<AgentEvent>`), `dispose`, and optionally
`interrupt`, `hasSession`, `retryTurn`. Stage plugin docs with
`stagedPluginFiles` / `buildPluginsPreamble`.

**Runtime cutover in progress.** ADRs 0067 and 0095 accept
`AgentRuntimeProvider` (`coding-agent/runtime-provider.ts`: sequenced events,
resumable sessions, `AgentLoopPlacement` instead of topology).
`AiSdkAgentRuntime` and `ClaudeCodeAgentRuntime` implement it and
`runtime-conformance.ts` tests it, but core still drives sessions through
`CodingAgentProvider`. When you change harness behavior, keep both paths
consistent.

Rules that hold across harnesses:

- **Delegation** is first-class: agent definitions declare routes and a child
  concurrency limit; core creates ordinary child sessions (hierarchy separate
  from fork lineage). A native subagent is only an optimization when it keeps
  that contract.
- **Skills** live in `.catamorphic/skills/<name>/SKILL.md`; agents read them
  from their checkout. `GET /api/projects/:projectId/skills` lists them.
- **Connections**: project agents declare aliases in
  `.catamorphic/agents/<slug>.json`. A workflow that delivers to that agent
  declares the same aliases in its `connections` so the member authorizes them
  before enabling it.
- **Reaching a chat from a workflow** is `catamorphic.sessions.deliver`, by
  `sessionId` or by `key` (ADR 0156). It queues an ordinary turn through
  `AgentSessionsService` with normal Environment admission, connection checks,
  and tool-policy narrowing; it never runs an agent inside the workflow sandbox.
- **Model catalogs** are discovered on demand: Claude Code via
  `listClaudeCodeModels` (`supportedModels`), Codex via `listCodexModels`
  (app-server `model/list`). Never hardcode a catalog or call
  `codex debug models`. Bound process lifetime, follow pagination, filter
  hidden models, and report errors without starting a turn.
- **Codex** keeps its app-server process and MCP children alive for the
  session and closes them on disposal, transport failure, or an abandoned
  stream. Pending approvals are cancelled when their turn ends (ADR 0112).

## Placement, Environments, and machines

- Environments and immutable Allocations select provider, resources, and
  connection grants (ADR 0064). Project permissions such as `program:write`
  never imply Environment or connection authority; roles grant `environments`.
- An Allocation must route the actual process, workspace, tools, and recovery
  owner. Recording an Environment without routing execution is not placement.
- Managed machines are server instances sharing network Postgres and one
  authority (ADR 0099). Nodes hold renewable leases; session branches persist
  before a turn completes. A member's **This machine** (`binding:
  "this-machine"`) runs sandbox operations on the member device through the
  SDK client runner while the model loop and credential broker stay on the
  server, with no Postgres credentials (ADR 0098). Do not advertise native CLI
  execution over that transport.
- Keep the public [cluster reference](../../../skills/setup-work-server/references/cluster-deployment.md)
  accurate when these behaviors change.

## Resource admission (ADR 0100)

- Managed Allocations reserve a workspace slot plus CPU/memory atomically
  under a node row lock and own one sandbox each.
- Capacity returns only after physical cleanup succeeds. Heartbeat expiry is
  never proof that a VM stopped; keep cleanup independent of heartbeats and
  keep the operator recovery path for ambiguous create/destroy outcomes.
- Requested limits must reach sandbox creation, including through client
  runner RPC. Native CLI paths do not gain limits by declaring them.
- Verify real VM CPU/memory, concurrent admission races, cleanup failures,
  archive/restore, and worker fencing.

## Harness capabilities and monitors (ADR 0101, 0156)

- Keep native file, shell, and media tools within the permission mode. Replace
  private todos, delegation, and monitors only where the host provides the
  session equivalent.
- When changing CLI flags, tool names, skill discovery, cwd, or resume, verify
  the pinned executable against a loopback model/MCP fixture. SDK type comments
  are not evidence of CLI behavior. Never use real model credentials in a
  deterministic protocol test.
- Shell polling is `watch_command` (host background work). Session watchers
  (`create_watcher`) cover Project Events and workflow IO. Author temporary
  watcher source with `ProjectManager.openEphemeral`, never a user's `openDev`.
  Dispose checkouts on failure, stop activations on close/archive/expiry, and
  abort and join polling before closing the database.

## Agent context and host capabilities (ADR 0103, 0152)

Read [AGENT-CAPABILITIES.md](../../../AGENT-CAPABILITIES.md) first. Reuse
`AgentCapabilitiesService`, `defineAgentCapability`, and the existing discovery
and invocation adapters; do not add a permanent tool family or an admin agent
role. Pin gateways to the current Allocation, refresh identity through
`resolveMemberIdentity`, and enforce access inside the owning service. Test
revocation after discovery, stale Allocation denial, cancellation, and parity
across HTTP, MCP, and in-process invocation. Context and schemas are hints,
never authorization.

## Storage backends

Chosen by the host through `createCatamorphic({ storage })`: `{ projectsPath,
remotesPath }` uses `FsBackend`/`FsRemoteBackend` from `@catamorphic/git`;
`{ projectManager }` takes custom wiring such as `ObjectRemoteBackend` with
`S3ObjectStore` (`@catamorphic/s3`, ADR 0012), `ArtifactsRemoteBackend`
(`@catamorphic/cloudflare`), or the experimental `DaytonaBackend`.

Run, session, and delegation routes are listed in `INTEGRATION.md`.
