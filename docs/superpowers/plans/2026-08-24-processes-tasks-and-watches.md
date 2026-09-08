# Processes, Tasks, and Watches Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Allocation-owned processes and host-owned Watches authoritative across turns and execution locations while preserving provider tasks as a distinct activity kind.

**Architecture:** Runner process operations provide the execution authority; core persists sanitized metadata, output cursors, Watch definitions, leases, and observations. Provider tasks and subagents normalize into the runtime event model but are controlled only when their provider advertises control.

**Tech Stack:** TypeScript, Bun PTY/subprocesses, Kysely/Postgres, Fastify/OpenAPI, React Query, Electron terminals, Vitest, Playwright, OpenTelemetry.

**Spec:** `docs/superpowers/specs/2026-08-24-agent-runtime-capabilities-and-personal-artifacts-design.md`

## Global Constraints

- Terminals are views of process ids.
- Closing a terminal does not stop its process.
- Persistent background work uses `process.start`; command-text heuristics are forbidden.
- A provider-owned process is exposed only when authoritative read/write/stop/status operations exist.
- Watches survive turns but not a revoked owner or released scope.
- Do not stage or commit without explicit user approval.

---

### Task 1: Add process operations to Allocation runners

**Files:**
- Modify: `packages/sandbox/src/runner/types.ts`
- Create: `packages/sandbox/src/runner/process-types.ts`
- Create: `packages/sandbox/src/runner/__tests__/process-contract.test.ts`
- Modify: `packages/local-process/src/local-allocation-runner.ts`
- Create: `packages/local-process/src/__tests__/local-process-control.test.ts`
- Modify: `packages/cloudflare/src/cloudflare-allocation-runner.ts`
- Modify: `packages/cloudflare-sandbox-bridge/src/index.ts`

**Interfaces:**
- Produces: `RunnerProcess`, `RunnerProcessCursor`, and runner methods `startProcess/listProcesses/getProcess/readProcess/writeProcess/stopProcess`.

- [ ] **Step 1: Write failing process contract tests**

Start a PTY, read output after cursor 0, write input, stop it, and assert a second stop is idempotent. Reject access from another Allocation and verify bounded output returns `nextCursor` plus `truncated`.

- [ ] **Step 2: Run local and sandbox contract tests**

Expected: FAIL because runner process methods are absent.

- [ ] **Step 3: Define exact process state**

```ts
export type RunnerProcessStatus = "starting" | "running" | "exited" | "failed" | "stopped";
export interface RunnerProcess {
  id: string;
  allocationId: string;
  kind: "pty" | "command";
  commandSummary: string;
  cwd: string;
  status: RunnerProcessStatus;
  exitCode?: number;
  startedAt: string;
  endedAt?: string;
}
```

- [ ] **Step 4: Implement local and remote controls**

Keep process handles inside the owning runner keyed by Allocation and process ids. Store only explicit environment values passed by the host. Remote calls carry the lease fence and return sanitized metadata and output chunks.

- [ ] **Step 5: Pass focused tests**

Expected: local PTY round trip and remote transport fixtures expose the same contract.

### Task 2: Persist process metadata and expose process capabilities/API

**Files:**
- Create: `packages/db/migrations/061_allocation_processes_and_watches.sql`
- Modify: `packages/db/src/generated/db.ts`
- Create: `packages/core/src/services/allocation-processes-service.ts`
- Create: `packages/core/src/__tests__/allocation-processes.integration.test.ts`
- Create: `packages/core/src/capabilities/process-capabilities.ts`
- Create: `packages/fastify-plugin/src/routes/processes.ts`
- Modify: `packages/fastify-plugin/src/schemas.ts`
- Modify: `packages/fastify-plugin/src/plugin.ts`

**Interfaces:**
- Consumes: Allocation runner service and capability gateway.
- Produces: canonical `process.start/list/get/read/write/stop/attach` capabilities and typed HTTP routes.

- [ ] **Step 1: Write failing ownership and release tests**

Assert a session member can manage its process, another project member without session access cannot, process metadata survives turn completion, and Allocation release stops non-detached processes.

- [ ] **Step 2: Run focused tests and confirm persistence is absent**

Run the new integration suite.

- [ ] **Step 3: Add the process portion of migration 061**

Create `allocation_processes` with Allocation/session/turn owner references, runner process id, kind, command summary, cwd, status, exit fields, detached policy, timestamps, and last output cursor. Do not persist the full environment or unbounded output.

- [ ] **Step 4: Implement service and capability registrations**

Every method revalidates project/session access and current Allocation lease before calling the runner. Use the capability invocation cancellation signal for start/read. Emit runtime process events after persisted state transitions.

- [ ] **Step 5: Add prefix-relative routes and generate clients**

Expose process list/get/read/write/stop for UI clients; agent invocation uses the gateway. Generate OpenAPI and the API client, then pass focused tests.

### Task 3: Add durable Watch definitions and providers

**Files:**
- Create: `packages/core/src/services/watch-types.ts`
- Create: `packages/core/src/services/watches-service.ts`
- Create: `packages/core/src/services/watch-worker.ts`
- Create: `packages/core/src/capabilities/watch-capabilities.ts`
- Create: `packages/core/src/__tests__/watches-service.integration.test.ts`
- Create: `packages/core/src/__tests__/watch-worker.integration.test.ts`
- Modify: `packages/db/migrations/061_allocation_processes_and_watches.sql`
- Modify: `packages/db/src/generated/db.ts`

**Interfaces:**
- Produces: `Watch`, `WatchTarget`, `WatchCondition`, `WatchObservation`, `WatchProvider`, and `watch.create/list/get/stop`.

- [ ] **Step 1: Write failing condition and lease tests**

Cover process exit, output match, file change, port ready, HTTP status, git ref, PR/CI state, expiry, duplicate observations, and worker lease fencing. Use fake providers for HTTP and CodeHost tests.

- [ ] **Step 2: Run focused tests and confirm Watch services are absent**

Run both new Watch suites.

- [ ] **Step 3: Complete migration 061**

Create `watches` with owner scope, optional Allocation/session/enablement, kind, target/condition JSONB, status, strategy, next check, expiry, wake action, lease fields, last observation, and timestamps. Create `watch_observations` with a unique provider event key.

- [ ] **Step 4: Implement providers and worker claims**

Use `FOR UPDATE SKIP LOCKED` to claim due polling Watches. Event-backed process Watches subscribe to runner events. File/port checks execute through the runner; HTTP and CodeHost checks execute through host providers. Persist the observation before emitting a wake action.

- [ ] **Step 5: Register canonical capabilities and pass tests**

Input schemas use discriminated Watch kinds. Stop is idempotent. Expected: a Watch created during one turn can wake activity after that turn ends.

### Task 4: Normalize provider tasks and build activity UI

**Files:**
- Modify: `packages/claude-code/src/claude-code-agent.ts`
- Modify: `packages/codex/src/codex-agent.ts`
- Modify: `packages/core/src/services/agent-runtime-events-service.ts`
- Create: `packages/react/src/hooks/use-agent-activities.ts`
- Create: `packages/react/src/hooks/use-processes.ts`
- Create: `packages/react/src/hooks/use-watches.ts`
- Create: `apps/desktop/src/renderer/components/agent-activity-list.tsx`
- Create: `apps/desktop/src/renderer/components/process-chip.tsx`
- Create: `apps/desktop/src/renderer/components/watch-chip.tsx`
- Modify: `apps/desktop/src/renderer/components/catamorphic/chat-timeline.tsx`
- Modify: `apps/desktop/src/main/terminal.ts`
- Modify: `apps/desktop/src/renderer/screens/terminal-screen.tsx`

**Interfaces:**
- Consumes: normalized runtime task/process/Watch events and generated APIs.
- Produces: shared activity presentation and terminal attachment by process id.

- [ ] **Step 1: Write component and attachment tests**

Require separate icons/states for provider task, subagent, process, and Watch. Closing a terminal tab leaves the process running; choosing Stop updates all attached views.

- [ ] **Step 2: Run focused desktop tests and confirm UI lacks normalized records**

Run component tests and terminal main-process tests.

- [ ] **Step 3: Map provider tasks without inventing control**

Claude and Codex descriptors state task-control support. UI controls render only for operations advertised by the provider. Observed-only tasks show status without Stop or Send Input actions.

- [ ] **Step 4: Attach terminals by process id**

Replace renderer-owned shell launch for agent processes with an attach request. Preserve standalone user terminals as desktop-local processes registered through the same local runner.

- [ ] **Step 5: Verify the sub-plan**

Run migration/codegen, API generation, focused and full tests, desktop e2e, lint, typecheck, build, and `git diff --check`. Stop at a reviewable working-tree checkpoint.
