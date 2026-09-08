# Temporary Watchers and Session Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every Catamorphic agent durable attributed cross-session delivery and temporary code-first Watchers, with GitHub events available automatically in the desktop when the user can access the linked repository.

**Architecture:** Server-owned session messages and turn claims replace the React queue. Durable Project Events normalize ingress, GitHub supplies webhook and polling strategies, and Watchers bind those events to an immutable TypeScript workflow commit on a temporary git ref. Existing Workflow Runs, Environments, Allocations, connection admission, and deployment artifacts execute each Watcher invocation.

**Tech Stack:** TypeScript, Zod, Kysely/Postgres and PGlite, Fastify/OpenAPI, React Query, Electron, GitHub REST/webhooks, isomorphic-git, Bun workflow runtime, Vitest, Playwright, OpenTelemetry.

**Spec:** `docs/superpowers/specs/2026-08-28-temporary-watchers-and-session-delivery-design.md`

## Global Constraints

- TypeScript workflow code is the only Watcher logic source.
- Every Watcher Run pins an exact commit and deployment artifact.
- Temporary Watcher refs never merge into project `main`.
- Session queue authority is durable core state, never React state.
- Non-user authorship is preserved in storage, API, UI, and model context.
- GitHub credentials remain in the host and all access is revalidated.
- New routes define Zod first and regenerate OpenAPI and client types.
- New hot paths use `@catamorphic/otel` and never trace message/event payloads.
- Do not stage, commit, or push without explicit user approval.

---

### Task 1: Durable session messages and serialized turns

**Files:**
- Create: `packages/db/migrations/064_durable_session_delivery.sql`
- Create: `packages/core/src/services/agent-turns-service.ts`
- Create: `packages/core/src/__tests__/agent-turns-service.integration.test.ts`
- Modify: `packages/core/src/services/agent-sessions-service.ts`
- Modify: `packages/core/src/core.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/fastify-plugin/src/schemas.ts`
- Modify: `packages/fastify-plugin/src/routes/agent.ts`
- Modify: `packages/fastify-plugin/src/project-mcp-surface.ts`
- Modify: `packages/react/src/hooks/use-agent-chat.ts`
- Modify: `packages/react/src/hooks/use-send-agent-message.ts`
- Modify: `packages/react/src/types.ts`

**Interfaces:**
- Produces: `SessionMessageAuthor`, `SessionDeliveryMode`, `SessionDeliveryReceipt`, `AgentTurnsService.enqueue/claim/complete/fail`, and `AgentSessionsService.deliver`.
- Consumes: existing provider anchoring and turn execution as the temporary worker backend until the accepted `AgentRuntimeProvider` cutover reaches core.

- [ ] **Step 1: Write failing integration tests**

Cover literal outcomes: attributed watcher and peer-agent messages retain their author, duplicate idempotency keys return one message, `message_only` creates no turn, two `next_turn` deliveries claim in order, only one running turn exists, and `interrupt` becomes the next turn after requesting interruption.

- [ ] **Step 2: Verify the new tests fail because the schema/service is absent**

Run `bunx vitest run packages/core/src/__tests__/agent-turns-service.integration.test.ts --config vitest.config.ts`.

- [ ] **Step 3: Add migration 064 and domain types**

Add `author_kind`, `author_external_user_id`, `author_session_id`, `author_agent_id`, `source_workflow_run_id`, `source_watcher_id`, `delivery_mode`, and `idempotency_key` to `agent_messages`. Create `agent_turns` with session/message ids, monotonic sequence, priority, `pending | running | completed | failed | interrupted`, lease fields, timestamps, and one-running-per-session partial unique index.

- [ ] **Step 4: Implement queue transactions and the session delivery API**

`deliver` validates project/session visibility and author authority, inserts the message plus optional turn atomically, and returns immediately. `next_turn` has priority 0; `interrupt` has priority 100 and invokes the existing provider interrupt once before claim.

- [ ] **Step 5: Move turn execution behind the durable claim**

Extract the existing `runTurn` body behind one `executeClaimedTurn` callback. A user send calls `deliver`, starts the session drain, and returns the receipt. Startup and session reads re-drive pending or expired turns. Retain one blocking `deliverAndWait` method only for synchronous MCP `ask_agent`; it waits on the durable turn row rather than bypassing the queue.

- [ ] **Step 6: Cut routes and generated types over**

Add `POST .../messages` fields `deliveryMode` and `idempotencyKey`; add the agent-facing `send_session_message` MCP tool with explicit author and same-project authorization. Regenerate spec and client types.

- [ ] **Step 7: Delete the React queue**

Remove `QueuedAgentMessage`, `queueRef`, queue editing/promote methods, and client-side sequential dispatch. Each composer action sends once and renders server message/turn state. `sendNow` sends `deliveryMode: "interrupt"`.

- [ ] **Step 8: Pass focused service, route, hook, and desktop queue tests**

Run the core integration suite, agent route tests, React hook tests, and the queue/interrupt desktop e2e cases.

### Task 2: Durable Project Events and GitHub source

**Files:**
- Create: `packages/db/migrations/065_project_events_and_monitors.sql`
- Create: `packages/core/src/services/project-event-types.ts`
- Create: `packages/core/src/services/project-events-service.ts`
- Create: `packages/core/src/services/project-event-sources.ts`
- Create: `packages/core/src/services/monitors-service.ts`
- Create: `packages/core/src/services/monitor-worker.ts`
- Create: `packages/core/src/__tests__/project-events-service.integration.test.ts`
- Create: `packages/core/src/__tests__/monitor-worker.integration.test.ts`
- Modify: `packages/github/src/api.ts`
- Modify: `packages/github/src/index.ts`
- Create: `packages/github/src/events.ts`
- Create: `packages/core/src/services/github-events-source.ts`
- Create: `packages/fastify-plugin/src/routes/events.ts`
- Modify: `packages/fastify-plugin/src/schemas.ts`
- Modify: `packages/fastify-plugin/src/plugin.ts`
- Modify: `apps/desktop/src/main/server/boot.ts`
- Modify: `apps/server/src/server.ts`

**Interfaces:**
- Produces: `ProjectEvent`, `ProjectEventsService.append/list`, `ProjectEventSourceProvider`, `Monitor`, fenced polling claims, and the `github` source provider.
- Consumes: existing `GithubService`, CodeHost-linked project remotes, and host identity.

- [ ] **Step 1: Write failing event dedupe and Monitor lease tests**

Assert two appends with one provider event id create one row; polling commits cursor only after all returned events append; an expired lease is reclaimable; revoked access suspends only that Monitor.

- [ ] **Step 2: Verify focused failures**

Run the two new core suites before adding production files.

- [ ] **Step 3: Add migration 065 and services**

Create `project_events`, `project_event_monitors`, and `project_event_monitor_cursors`. Implement append-before-dispatch and `FOR UPDATE SKIP LOCKED` polling claims with fenced completion.

- [ ] **Step 4: Implement GitHub normalization and access checks**

Extend `GithubApi` with PR timeline, reviews, check runs/suites, and Actions workflow runs using literal GitHub response fixtures. Normalize both REST polling and webhook payloads into the same event names and subjects.

- [ ] **Step 5: Expose webhook ingestion and desktop polling**

Register a signature-verifying host route when a GitHub App webhook secret is configured. Desktop auto-creates or refreshes a polling Monitor for each GitHub-linked project after repository access succeeds, starts the Monitor worker at boot, and nudges it on focus and OS wake.

- [ ] **Step 6: Generate APIs and pass GitHub/core/host tests**

Regenerate OpenAPI/client types, then run GitHub API fixtures, event services, desktop boot tests, and stock server route tests.

### Task 3: Temporary Watcher deployments and dispatch

**Files:**
- Create: `packages/db/migrations/066_temporary_watchers.sql`
- Create: `packages/core/src/services/watcher-types.ts`
- Create: `packages/core/src/services/watchers-service.ts`
- Create: `packages/core/src/services/watcher-dispatcher.ts`
- Create: `packages/core/src/__tests__/watchers-service.integration.test.ts`
- Create: `packages/core/src/__tests__/watcher-dispatcher.integration.test.ts`
- Modify: `packages/git/src/network.ts`
- Modify: `packages/git/src/index.ts`
- Modify: `packages/core/src/services/runs-service.ts`
- Modify: `packages/core/src/services/host-calls.ts`
- Modify: `packages/core/src/core.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/fastify-plugin/src/project-mcp-surface.ts`
- Create: `packages/fastify-plugin/src/routes/watchers.ts`
- Modify: `packages/fastify-plugin/src/schemas.ts`
- Modify: `packages/fastify-plugin/src/plugin.ts`
- Modify: `packages/core/src/seeds.ts`

**Interfaces:**
- Produces: `Watcher`, `WatcherSubscription`, `WatchersService.create/list/get/stop`, `WatcherDispatcher.dispatch`, `RunsService.triggerAtCommit`, `watchers.*` and `sessions.deliver` host capabilities.
- Consumes: Project Events, deployment artifacts, Environment admission, connection admission, git remote refs, and durable session delivery.

- [ ] **Step 1: Write failing lifecycle and dispatch tests**

Cover source parse rejection, exact watcher ref/commit pinning, no mutation of project `main`, finite expiry, exact Environment, duplicate event dispatch, one Run per event, silent workflow completion, and workflow-originated attributed `next_turn` delivery.

- [ ] **Step 2: Verify focused failures**

Run both new Watcher suites before implementation.

- [ ] **Step 3: Add migration 066 and exact-ref git operations**

Create `watchers`, `watcher_subscriptions`, and `watcher_dispatches`. Add explicit push/fetch/delete operations for `catamorphic/watchers/<uuid>` refs without changing the project's configured main branch.

- [ ] **Step 4: Snapshot and validate TypeScript source**

Creation checkpoints the selected source, parses the export with the canonical parser, validates event input, pushes the temporary ref, resolves its deployment artifact, admits Environment/connections, and persists lifecycle state. Failures before persistence remove a pushed ref when safe.

- [ ] **Step 5: Add exact-commit Run enrollment and dispatcher**

`triggerAtCommit` reuses the canonical production state machine but loads the pinned watcher ref and SHA. Dispatch inserts its idempotency row before creating a Run and records the Run id transactionally.

- [ ] **Step 6: Add workflow and agent capabilities**

Register built-in `sessions.deliver` and `watchers.stop` host calls. Add project MCP tools `create_watcher`, `list_watchers`, `get_watcher`, `stop_watcher`, and `send_session_message`. Update the seeded workflow/agent mechanics guidance with source, expiry, terminal-condition, and interruption rules.

- [ ] **Step 7: Add typed routes and pass focused tests**

Define Zod first, generate APIs, and run Watcher, trigger, Run, host-call, and project MCP tests.

### Task 4: Cross-host mailbox and reference-host experience

**Files:**
- Create: `packages/db/migrations/067_session_mailboxes.sql`
- Create: `packages/core/src/services/session-mailboxes-service.ts`
- Create: `packages/core/src/__tests__/session-mailboxes-service.integration.test.ts`
- Create: `packages/fastify-plugin/src/routes/session-mailboxes.ts`
- Modify: `packages/fastify-plugin/src/schemas.ts`
- Modify: `packages/fastify-plugin/src/plugin.ts`
- Create: `packages/react/src/hooks/use-watchers.ts`
- Modify: `packages/react/src/index.ts`
- Modify: `packages/registry/src/chat-timeline/chat-timeline.tsx`
- Create: `apps/desktop/src/renderer/components/watchers-panel.tsx`
- Create: `apps/desktop/src/renderer/components/watcher-chip.tsx`
- Modify: `apps/desktop/src/renderer/app.tsx`
- Modify: `apps/desktop/src/renderer/components/catamorphic/chat-timeline.tsx`
- Modify: `apps/desktop/src/main/remote-mirror.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/pwa/src/components/catamorphic/chat-timeline.tsx`
- Modify: `apps/pwa/src/lib/api.ts`
- Modify: `apps/desktop/src/main/server/e2e-fakes.ts`
- Create: `apps/desktop/e2e/watchers.e2e.ts`
- Modify: `apps/desktop/DESIGN.md`

**Interfaces:**
- Produces: authority-revisioned session mailbox export/import/ack, Watcher hooks/UI, and attributed chat rendering.
- Consumes: durable messages, Watchers, remote OAuth token supplier, mirror handoff markers, and generated APIs.

- [ ] **Step 1: Write failing authority and mailbox tests**

Assert local authority receives local delivery, remote authority creates one outbox item, repeated import is idempotent, stale authority revision rejects delivery, offline items remain pending, and handoff redirects future items without reviving the stale fork.

- [ ] **Step 2: Verify focused failures**

Run the mailbox integration suite before adding migration/service code.

- [ ] **Step 3: Add migration 067, mailbox service, and typed routes**

Persist host instance ids and authority revisions on sessions plus durable mailbox items and acknowledgements. Expose export/import/ack through authenticated project-scoped routes and regenerate APIs.

- [ ] **Step 4: Implement desktop linked-remote mailbox sync**

Use the existing remote token supplier. Pull on app focus, OS wake, and while linked sessions have pending activity; import through core, then ack. Preserve incognito and fork privacy rules.

- [ ] **Step 5: Apply modern web guidance and build the UI**

Run the mandatory modern-web-guidance lookup before editing client code. Render author badges for agent, workflow, and Watcher messages; render Watcher source, Environment, expiry, last event/Run, status, and Stop. Keep components driven by generated hooks and provider-neutral records.

- [ ] **Step 6: Add desktop e2e and visually verify**

The fake GitHub source emits a PR event, the temporary workflow condition delivers a Watcher-authored `next_turn`, the idle session wakes, the chip links to its Run/source, and Stop prevents another delivery. Capture a maximized desktop screenshot and inspect console output.

- [ ] **Step 7: Run the full verification matrix**

Run migrations/codegen, API generation twice, root lint, typecheck, build, tests, desktop unit/e2e/visible e2e, browser verification, `git diff --check`, and `git status --short`. Do not stage or commit.
