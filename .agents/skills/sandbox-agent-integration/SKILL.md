---
name: sandbox-agent-integration
description: Use when changing sandbox providers, workflow execution runtimes, coding-agent harnesses (ai-sdk, claude-code, codex), the coding-agent registry, Environment placement and Allocations, managed-machine enrollment, dev sandboxes, workspace resource admission, sandbox instrumentation, or plugin/agent file staging.
---

# Sandbox and agent integration

Two vendor-neutral contracts, neither with vendor SDKs:

- `SandboxProvider` (`@catamorphic/sandbox`, `src/types.ts`): where workflow
  code and controller-agent commands execute.
- `HarnessAdapter` (`@catamorphic/agent-protocol/runner`): a coding-agent
  harness, run by the agent runner for one attempt of a turn (ADR 0198).

Hosts construct concrete providers explicitly at boot and pass them to
`createCatamorphic`. There is no env-var switch inside the libraries.

## Where things live

| Concern | Path |
| --- | --- |
| Provider, runtime, resource types | `packages/sandbox/src/types.ts`, `execution-environment.ts` |
| OTel wrapper | `packages/sandbox/src/instrumented-provider.ts` |
| Warm deployment runtimes | `packages/sandbox/src/command-deployment-runtime.ts` (HTTP supervisor), `stdio-deployment-runtime.ts` |
| Session log and runner protocol | `packages/agent-protocol/src/` (`model.ts`, `events.ts`, `commands.ts`, `state.ts` reducer, `runner.ts`: `HarnessAdapter`, `AttemptStart`, frames and commands) |
| Agent runner | `packages/agent-runner/src/` (`runner.ts` `AttemptRunner`, `in-process.ts`, `stdio.ts`, `echo-adapter.ts`); `packages/runner-bundle` (the sandbox bundle and its adapters) |
| Harness helpers | `packages/sandbox/src/coding-agent/` (`types.ts`, `plugin-staging.ts`, `tool-policy.ts`, `harness-permissions.ts`, `questions.ts`) |
| Supervisor inside the runtime | `packages/runtime/src/` (`supervisor-http.ts`, `supervisor-stdio.ts`, `supervisor-dispatcher.ts`, `bun-worker.ts`) |
| Core services | `packages/core/src/services/`: `deployment-runtime-service.ts`, `execution-worker-service.ts`, `dev-sandbox-service.ts`, `execution-environments-service.ts`, `execution-allocations-service.ts`, `worker-nodes-service.ts`, `client-runners-service.ts`, `coding-agent-registry.ts`, `agent-sessions-service.ts`, `sessions/` (`session-log.ts`, `turn-queue.ts`, `turn-engine.ts`, `turn-ingest.ts`, `native-state.ts`, `context-handoff.ts`), `agent-capabilities-service.ts` |
| Harness adapters | `packages/ai-sdk` (`createAiSdkAdapter`), `packages/claude-code` (`createClaudeCodeAdapter`), `packages/codex` (`createCodexAdapter`); each has a `/testing` subpath for recorded-transcript replay |
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
  `resourceLimits`, `deploymentRuntime`, `processes`, and the optional `hydrateWorkspace`
  (Cloudflare tar upload); forward any new optional member the same way.
- `deploymentRuntime` is the warm-runtime capability. Cloudflare and Daytona
  use `CommandDeploymentRuntimeProvider`; local-process and microsandbox use
  `StdioDeploymentRuntimeProvider`.
- `processes` is the background-process capability (ADR 0174, `src/processes.ts`):
  start, read by byte cursor (optionally blocking up to 20s), signal the
  process group, list. Output stays in the sandbox and processes die with it.
  local-process implements it natively; microsandbox uses `shellSandboxProcesses`
  over `executeCommand`; the worker and member-runner forwarders carry it as
  `process.*` operations. Cloudflare and Daytona omit it. Follow a process with
  `followProcess`, never a long-held request.
- A new provider reports its real `isolation` (`none | process | sandbox`) and
  lists enforceable `resourceLimits`. It must reject `CreateSandboxOpts.resources`
  it cannot enforce rather than ignore them.
- `environmentProvider` is required. `defineStaticEnvironments` (server-sdk)
  maps Environment descriptors to providers; see `INTEGRATION.md`.

## Workflow execution

- Every Run executes an immutable deployed commit. There is no mutable-source
  or test mode.
- The deployment runtime materializes the verified `.work/` capability
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
  set `WORK_APP_DATA_DIR`; it is absent otherwise.
- Tables: `workflow_runs` (one per invocation), `workflow_run_states`,
  `workflow_step_attempts`, `workflow_pauses`, `workflow_run_steps`,
  `workflow_run_events`, `execution_jobs`, plus batch item/sink tables.

## Agent checkouts

Agents edit mutable code that Runs never execute. Controller agents
(ai-sdk) edit a dev sandbox managed by `DevSandboxService` (which uses
`SandboxManagerImpl` internally). Native harnesses (Claude Code, Codex) can use a
host-resolved local checkout through `createCatamorphic({ nativeAgentCheckout })`.

## Coding-agent harnesses

`createCatamorphic({ hostId, codingAgent })` accepts one `RegisteredCodingAgent`
or a `CodingAgentRegistry` (`packages/core/src/services/coding-agent-registry.ts`;
`singleAgentRegistry` wraps one agent). `hostId` is required when `codingAgent`
is set; without `codingAgent`, session routes answer 503. A
`RegisteredCodingAgent` carries `id`, `harness`, `topology`, `options`,
`sandboxing`, `toolPolicies`, `environment`, `connectionRequirements`,
`modelConnection`, `signIn`, `defaults`, `systemPrompt`, `delegation`, and
`recovery`. `harness` says where the runner runs:

- `{ placement: "host", adapter }`: an adapter in this process (the desktop's
  harnesses, the built-in agent). Only a host harness takes host hooks:
  `local(context)` (host objects, never serialized), `env`, `hostTools`,
  `mcpServers(context)` (read every turn so rotated tokens apply),
  `toolPolicies()`, `toolAnnotations()`, `plugins`, `context(context)` (per-turn
  facts, ADR 0152), and `instructions`.
- `{ placement: "sandbox", id }`: the runner bundle inside the session's
  sandbox runs the bundled adapter `id` (`claude-code`, `codex`) beside its CLI.

```typescript
import { createAiSdkAdapter } from "@catamorphic/ai-sdk";

const agent: RegisteredCodingAgent = {
  id: "assistant",
  harness: { placement: "host", adapter: createAiSdkAdapter({ model, resolveModel }) },
  topology: "controller",
};
```

Sessions are an event log of turns (ADR 0197): `SessionLog.append` is the one
writer of `agent_session_events` and its projections (turns, attempts, items,
runtime requests, provider threads), and every mutating command carries a
client `commandId`. The turn engine drives each turn from Postgres through
`queued → preparing → running ⇄ waiting → finalizing → settled` under a lease
(ADR 0198); orchestration, persistence, checkout selection, checkpointing, and
recovery stay in core, never in a harness.

To add a harness, implement `HarnessAdapter`: `id`, `capabilities()` (a
`HarnessCapabilities`: native steer, interrupt, retry, fork, rollback,
questions, approvals, elicitations, subagents, streamed text, `nativeState`, and
id strengths), and `start(attempt, host, local?)` returning `AttemptControl`
(`steer`, `interrupt`, `finished`). The adapter emits `HarnessEvent`s through
`host.emit` (`thread` as soon as it knows the native thread, items as they
happen, exactly one `turn.completed`), runs host tools with `host.callTool`,
decides tool calls with `host.authorize` (policy arrives as data in
`AttemptStart.toolPolicies`; only `ask` leaves the runner), opens questions and
approvals with `host.request`, and stores portable native state with
`host.nativeState`. Core picks fallbacks by capability, never by harness name.
Register a sandbox adapter in `packages/runner-bundle/src/sandbox-main.ts`, and
test it against the real `AttemptRunner` with recorded provider transcripts.
Core stages plugin docs (`stagedPluginFiles` / `stagePluginDocs`) in the working
directory and appends `buildPluginsPreamble` to the attempt's system prompt.

Rules that hold across harnesses:

- **Delegation** is first-class: agent definitions declare routes and a child
  concurrency limit; core creates ordinary child sessions (hierarchy separate
  from fork lineage). A native subagent is only an optimization when it keeps
  that contract.
- **Skills** live in `.work/skills/<name>/SKILL.md`; agents read them
  from their checkout. `GET /api/projects/:projectId/skills` lists them.
- **Connections**: project agents declare aliases in
  `.work/agents/<slug>.json`. A workflow that delivers to that agent
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
- **Shell budget.** The built-in harness runs a foreground command as a
  process it waits on when the sandbox has `processes`, bounded by the
  Allocation's `commandTimeoutSeconds` (handed to the adapter as
  `local.sandbox.commandBudgetSeconds`), and offers
  `run_background_command` / `read_background_output` / `stop_background_command`
  there. A host may keep the chat's shell (`local.shell`) across attempts, so
  a command started in one turn is read or stopped in the next, and then ends
  its background commands with `stopBackgroundCommands` when the chat closes
  (the desktop does).
  Desktop host background commands (ADR 0155) stay host terminals for every
  harness.
- **Codex** runs one pinned `codex app-server` process per attempt and
  closes it, with its MCP children, when the attempt ends or its transport
  fails. Its native state is the rollout file the runner mirrors. Pending
  approvals are cancelled when their turn ends (ADR 0112).
- **Sign-ins** stay on the machine they were made on (ADR 0199): an agent with
  `signIn` places only on a machine reporting the chat owner's sign-in, and
  Work never reads or moves the credential.

## Placement, Environments, and machines

- Environments and immutable Allocations select provider, resources, and
  connection grants (ADR 0064). Project permissions such as `program:write`
  never imply Environment or connection authority; roles grant `environments`.
- An Allocation must route the actual process, workspace, tools, and recovery
  owner. Recording an Environment without routing execution is not placement.
- Managed machines are server instances sharing network Postgres and one
  authority (ADR 0099). Nodes hold renewable leases; session branches persist
  before a turn completes. A member's **This machine** (`device:
  "member"`) runs sandbox operations on the member device through the
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
  watcher source with `ProjectManager.openEphemeral`, never a member's draft (`openDraft`).
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
