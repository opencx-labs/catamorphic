# Agent Runtime and Provider Fidelity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the turn-shaped coding-agent interface with resumable long-lived runtimes and faithful AI SDK, Claude Code, and Codex adapters.

**Architecture:** Dependency-light runtime contracts and a conformance kit live in `@catamorphic/sandbox`. Core persists normalized events and requests, drives commands, and broadcasts cursor-based updates. Each harness maps native protocol messages into the same contract; Codex uses a supervised app-server JSON-RPC process.

**Tech Stack:** TypeScript, Zod, Bun subprocesses, Claude Agent SDK, Codex app-server JSON-RPC, Kysely/Postgres, Fastify SSE, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-24-agent-runtime-capabilities-and-personal-artifacts-design.md`

## Global Constraints

- Sessions outlive turns; event subscription is independent from turn commands.
- Event delivery is at least once, ordered by per-session sequence, and deduplicated by event id.
- Approvals, questions, and elicitations are typed durable requests.
- Providers report unsupported features in descriptors instead of approximating them.
- Preserve Claude Code preset and settings-source fidelity.
- Remove Codex command-text daemon inference.
- Delete `CodingAgentProvider`, `AgentEvent`, and `sendMessage()` after all consumers move.
- Do not stage or commit without explicit user approval.

**Execution order:** Complete Tasks 1 and 2, then build the unconsumed new
provider runtimes in Tasks 4 and 5, then execute Task 3 as the atomic consumer
cutover and legacy deletion. This keeps every reviewed provider unit testable
without exposing a committed dual runtime surface.

---

### Task 1: Define runtime contracts and provider conformance tests

**Files:**
- Create: `packages/sandbox/src/coding-agent/runtime-types.ts`
- Create: `packages/sandbox/src/coding-agent/runtime-provider.ts`
- Create: `packages/sandbox/src/coding-agent/runtime-conformance.ts`
- Create: `packages/sandbox/src/coding-agent/__tests__/runtime-conformance.test.ts`
- Modify: `packages/sandbox/src/coding-agent/index.ts`
- Modify: `packages/sandbox/src/index.ts`

**Interfaces:**
- Produces: `AgentRuntimeProvider`, `AgentRuntimeDescriptor`, `AgentRuntimeEvent`, `AgentRuntimeRequest`, `AgentRuntimeSession`, `AgentTurnHandle`, `AgentEventCursor`, and `AgentLoopPlacement = "control_plane" | "environment"`.
- Produces: `defineAgentRuntimeConformance(factory)` used by every harness package.

- [x] **Step 1: Write the failing contract reducer tests**

Test duplicate delivery, cursor resume, request resolution, interruption, and task control with a fake provider:

```ts
defineAgentRuntimeConformance({
  create: () => new FakeAgentRuntime(),
  expected: { approvals: true, questions: true, tasks: true },
});
```

Assert that replaying the same `eventId` yields one reduced event and that subscribing after `{ sequence: 2 }` starts at sequence 3.

- [x] **Step 2: Run the focused test and confirm missing exports**

Run `bunx vitest run packages/sandbox/src/coding-agent/__tests__/runtime-conformance.test.ts --config vitest.config.ts`.

Expected: FAIL because `AgentRuntimeProvider` and the conformance helper do not exist.

- [x] **Step 3: Add the exact runtime shapes**

Use discriminated events and keyed parameters:

```ts
export interface AgentRuntimeProvider {
  describe(args: Record<string, never>): Promise<AgentRuntimeDescriptor>;
  startSession(args: StartAgentRuntimeSession): Promise<AgentRuntimeSession>;
  resumeSession(args: ResumeAgentRuntimeSession): Promise<AgentRuntimeSession>;
  stopSession(args: StopAgentRuntimeSession): Promise<void>;
  startTurn(args: StartAgentTurn): Promise<AgentTurnHandle>;
  retryTurn(args: RetryAgentTurn): Promise<AgentTurnHandle>;
  interruptTurn(args: InterruptAgentTurn): Promise<void>;
  respond(args: RespondToAgentRequest): Promise<void>;
  subscribe(args: SubscribeToAgentEvents): AsyncIterable<AgentRuntimeEvent>;
  listTasks(args: ListAgentTasks): Promise<readonly AgentTask[]>;
  controlTask(args: ControlAgentTask): Promise<void>;
}
```

Define the event envelope with `eventId`, `sequence`, `occurredAt`, `sessionId`, optional `turnId`, and a `type` union covering the families in the spec.

- [x] **Step 4: Implement the reusable conformance harness and pass it**

Run the focused Vitest command again. Expected: PASS with tests proving ordering, deduplication, cursor replay, and declared unsupported operations.

- [x] **Step 5: Review the contract boundary**

Run `git diff --check`. Confirm runtime types import no core, database, Fastify, Electron, or provider SDK module.

### Task 2: Persist runtime events and interaction requests

**Files:**
- Create: `packages/db/migrations/058_agent_runtime_events.sql`
- Modify: `packages/db/src/generated/db.ts`
- Create: `packages/core/src/services/agent-runtime-events-service.ts`
- Create: `packages/core/src/services/agent-runtime-requests-service.ts`
- Create: `packages/core/src/__tests__/agent-runtime-events.integration.test.ts`
- Create: `packages/core/src/__tests__/agent-runtime-requests.integration.test.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/src/core.ts`

**Interfaces:**
- Consumes: `AgentRuntimeEvent`, `AgentEventCursor`, `RespondToAgentRequest`.
- Produces: `AgentRuntimeEventsService.append/list/subscribe` and `AgentRuntimeRequestsService.create/respond/expire/listPending`.

- [x] **Step 1: Write failing integration tests**

Insert the same event twice and assert one row; insert sequence 3 before sequence 2 and require a conflict; create a question, answer it once, and require a second answer to fail with `AgentRequestAlreadyResolvedError`.

```ts
await events.append({ identity, event });
await events.append({ identity, event });
expect(await events.list({ identity, sessionId, afterSequence: 0 })).toHaveLength(1);
```

- [x] **Step 2: Run focused core tests and confirm the schema is absent**

Run `bunx vitest run packages/core/src/__tests__/agent-runtime-events.integration.test.ts packages/core/src/__tests__/agent-runtime-requests.integration.test.ts --config vitest.config.ts`.

- [x] **Step 3: Add migration 058**

Create `agent_runtime_events` keyed by `(session_id, sequence)` with unique `(session_id, event_id)`, JSONB payload, optional turn id, and timestamp. Create `agent_runtime_requests` with request kind, payload, status, expiry, response, actor, and optimistic revision. Add indexes for event cursor reads and pending request expiry.

- [x] **Step 4: Implement scoped services with spans**

Wrap append/respond paths with `withSpan`, use `catamorphic.session.id` and `catamorphic.agent.turn_id`, enforce `mayUseProject`, and publish only after the transaction commits. Exclude raw tool arguments from span attributes.

- [x] **Step 5: Migrate and pass focused tests**

Run `bun run db:migrate && bun run db:codegen`, then the focused tests. Expected: PASS and generated types include both tables.

### Task 3: Cut core sessions and HTTP clients over to runtime commands

**Files:**
- Modify: `packages/core/src/services/coding-agent-registry.ts`
- Modify: `packages/core/src/services/agent-sessions-service.ts`
- Modify: `packages/core/src/__tests__/agent-session-coordination.integration.test.ts`
- Modify: `packages/core/src/__tests__/agent-sessions-scope.integration.test.ts`
- Modify: `packages/fastify-plugin/src/routes/agent.ts`
- Modify: `packages/fastify-plugin/src/schemas.ts`
- Modify: `packages/react/src/hooks/use-agent-chat.ts`
- Modify: `packages/react/src/hooks/use-send-agent-message.ts`
- Modify: `packages/react/src/hooks/use-tool-permissions.ts`
- Modify: `packages/registry/src/agent-chat/agent-chat.tsx`
- Modify: `apps/pwa/src/lib/api.ts`
- Modify: `apps/pwa/src/screens/chat-screen.tsx`
- Modify: `apps/pwa/src/components/catamorphic/chat-timeline.tsx`
- Modify: `apps/pwa/src/components/agent-question-panel.tsx`

**Interfaces:**
- Consumes: runtime provider, event, and request services from Tasks 1 and 2 plus `AiSdkAgentRuntime`, `ClaudeCodeAgentRuntime`, and `CodexAgentRuntime` from Tasks 4 and 5.
- Produces: command routes for turns, interruption, retry, request response, tasks, and cursor-based event streaming; atomically deletes the old provider classes and runtime contract after every consumer moves.

- [ ] **Step 1: Rewrite service tests around commands and independent events**

Start a turn and return `202` with a turn id before the assistant completes. Subscribe separately and assert `turn.started`, message deltas, and `turn.completed`. Interrupt by turn id and answer a pending question after the original HTTP request has returned.

- [ ] **Step 2: Run the focused core tests and observe old synchronous behavior**

Run the two modified core integration suites. Expected: FAIL because `sendMessage()` still owns event consumption.

- [ ] **Step 3: Replace the registry and session orchestration**

Change `RegisteredCodingAgent.provider` to `AgentRuntimeProvider` and replace its topology field with `placement: AgentLoopPlacement`. The runner plan consumes this field; do not retain the four-value topology union as a compile bridge.

Have `AgentSessionsService.startTurn()` persist the user message, command the provider, and launch one supervised subscription pump per anchored provider session. The pump appends normalized events and reduces completed assistant messages into `agent_messages`.

- [ ] **Step 4: Replace HTTP and React behavior**

Expose:

```text
POST /projects/:projectId/agent/sessions/:sessionId/turns
POST /projects/:projectId/agent/sessions/:sessionId/turns/:turnId/retry
POST /projects/:projectId/agent/sessions/:sessionId/turns/:turnId/interrupt
GET  /projects/:projectId/agent/sessions/:sessionId/events?afterSequence=
POST /projects/:projectId/agent/sessions/:sessionId/requests/:requestId/respond
GET  /projects/:projectId/agent/sessions/:sessionId/tasks
POST /projects/:projectId/agent/sessions/:sessionId/tasks/:taskId/control
```

React Query posts commands and reduces the event cursor. Remove polling that assumes permissions exist only during an active turn.

- [ ] **Step 5: Generate clients and pass focused tests**

Run API spec/client generation, core tests, React hook tests, and PWA typecheck. Expected: commands return promptly and event replay reconstructs the same chat after remount.

- [ ] **Step 6: Delete the old providers and contract atomically**

Remove the legacy AI SDK, Claude Code, and Codex provider implementations and
their iterator-specific tests after host registries use the new runtime
classes. Remove `CodingAgentProvider`, `AgentEvent`, `sendMessage`, and
iterator retry APIs from `@catamorphic/sandbox`. Port still-relevant legacy
assertions into the runtime suites. Run
`rg "CodingAgentProvider|sendMessage\(|isLikelyDaemonCommand" packages apps`
and require no legacy runtime implementation matches.

### Task 4: Build AI SDK and Claude Code runtimes with full-fidelity events

**Files:**
- Create: `packages/ai-sdk/src/ai-sdk-runtime.ts`
- Create: `packages/claude-code/src/claude-code-runtime.ts`
- Create: `packages/ai-sdk/src/__tests__/ai-sdk-runtime.test.ts`
- Create: `packages/claude-code/src/__tests__/claude-code-runtime.test.ts`
- Modify: `packages/ai-sdk/src/index.ts`
- Modify: `packages/claude-code/src/index.ts`

**Interfaces:**
- Consumes: `AgentRuntimeProvider` and conformance kit.
- Produces: `AiSdkAgentRuntime` and `ClaudeCodeAgentRuntime` with dynamic policy callbacks. The old providers stay untouched until Task 3 atomically cuts over every consumer.

- [ ] **Step 1: Instantiate conformance suites for both providers**

Add provider-native fixtures that emit system init, partial assistant text, tool progress, question, plan, background task, usage, result, and turn end. Assert the normalized sequence exactly in the new runtime test files.

- [ ] **Step 2: Run provider tests and confirm both old adapters fail**

Run `bunx vitest run packages/ai-sdk/src/__tests__/ai-sdk-runtime.test.ts packages/claude-code/src/__tests__/claude-code-runtime.test.ts --config vitest.config.ts`.

- [ ] **Step 3: Implement long-lived AI SDK state**

Store provider session state in a map containing transcript, event buffer, subscribers, active turn, and request resolvers. `startTurn` launches the tool loop without returning its stream. Publish every event through the buffer and let `subscribe` replay from sequence.

- [ ] **Step 4: Implement the full Claude Agent SDK mapping**

Preserve `systemPrompt: { type: "preset", preset: "claude_code", append: ... }` and `settingSources: ["user", "project", "local"]`. Remove the static `allowedTools` array. Route `canUseTool`, `AskUserQuestion`, and MCP elicitation through typed requests; map system, assistant, result, plan, task, subagent, hook, and usage messages instead of dropping them.

- [ ] **Step 5: Pass conformance and integration tests**

Run both new provider runtime suites. Expected: PASS, including answering a question after the turn command returned. Task 3 ports the core ask-user integration test during the atomic cutover.

### Task 5: Build the Codex app-server runtime

**Files:**
- Create: `packages/codex/src/app-server/json-rpc-client.ts`
- Create: `packages/codex/src/app-server/codex-app-server.ts`
- Create: `packages/codex/src/app-server/protocol.ts`
- Create: `packages/codex/src/__tests__/app-server.test.ts`
- Create: `packages/codex/src/codex-runtime.ts`
- Create: `packages/codex/src/__tests__/codex-runtime.test.ts`
- Modify: `packages/codex/src/index.ts`
- Modify: `packages/codex/package.json`

**Interfaces:**
- Consumes: `AgentRuntimeProvider`, conformance kit, and the installed `@openai/codex` binary.
- Produces: `CodexAppServer` and `CodexAgentRuntime` with request correlation, notification stream, restart detection, and graceful shutdown. The old provider stays untouched until Task 3.

- [ ] **Step 1: Write JSON-RPC framing and request tests**

Feed split newline-delimited frames, out-of-order responses, notifications, and server requests into a fake subprocess. Assert ids correlate and an EOF rejects pending requests with `CodexAppServerDisconnectedError`.

- [ ] **Step 2: Run the app-server test and confirm the client is absent**

Run `bunx vitest run packages/codex/src/__tests__/app-server.test.ts --config vitest.config.ts`.

- [ ] **Step 3: Implement the supervised app-server client**

Resolve the packaged Codex binary, spawn `codex app-server` with an explicit environment and cwd, parse stdout only as protocol, send diagnostics from stderr as sanitized events, correlate JSON-RPC ids, and terminate gracefully on provider disposal.

- [ ] **Step 4: Map Codex protocol to runtime events and requests**

Start/resume Codex threads per runtime session. Handle command/file approvals, user input, and MCP elicitation as `AgentRuntimeRequest`s. Map items, plans, diffs, subagents, usage, and lifecycle notifications. Remove `isLikelyDaemonCommand` and every synthetic `codex-daemon-*` event.

- [ ] **Step 5: Pass conformance and provider tests**

Run the new app-server and runtime suites. Expected: authoritative app-server events pass conformance; no new test asserts daemon inference or coarse spawn-time `ask` behavior.

- [ ] **Step 6: Record the atomic-cutover handoff**

Verify `CodexAgentRuntime` is exported and tested while the legacy Codex provider remains unchanged. Task 3 consumes all three new runtimes and then removes `CodingAgentProvider`, `AgentEvent`, iterator APIs, daemon inference, and legacy adapter tests in one cutover.

- [ ] **Step 7: Verify the sub-plan**

Run lint, typecheck, build, all tests, API generation, and `git diff --check`. Stop at a reviewable working-tree checkpoint.
