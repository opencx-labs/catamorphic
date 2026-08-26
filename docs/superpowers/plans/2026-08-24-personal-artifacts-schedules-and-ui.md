# Personal Artifacts, Schedules, and UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add profile-scoped local artifacts, best-effort local workflow invocation, durable member/service schedules and wakeups, and the final cross-harness UI slices.

**Architecture:** The desktop discovers plain files under a locally excluded personal tree and keeps local schedule state in the profile. Core stores durable schedules and wakeups for committed workflow enablements in Postgres and dispatches them with fenced claims. Both surfaces are exposed as canonical gateway capabilities but have explicit local versus durable provenance.

**Tech Stack:** TypeScript, Node/Bun filesystem APIs, git local excludes, Kysely/Postgres, Fastify/OpenAPI, React Query, Electron, Vitest, Playwright, OpenTelemetry.

**Spec:** `docs/superpowers/specs/2026-08-24-agent-runtime-capabilities-and-personal-artifacts-design.md`

## Global Constraints

- Personal root is `.catamorphic/personal/<profile-id>/` inside the project working copy.
- Use `.git/info/exclude`; do not edit tracked `.gitignore`.
- No nested git repository, snapshot, sync, promotion record, or remote personal-artifact API.
- Personal workflow execution is a local development invocation, never a canonical Run.
- Durable schedules target exact committed workflow enablements.
- Personal schedules run only while the desktop is online and use current files.
- Sharing with the project is an agent task, not a mutation API.
- Do not stage or commit without explicit user approval.

---

### Task 1: Create and discover the personal artifact tree

**Files:**
- Create: `apps/desktop/src/main/personal-artifacts.ts`
- Create: `apps/desktop/src/main/personal-artifacts.test.ts`
- Modify: `apps/desktop/src/main/server/boot.ts`
- Modify: `apps/desktop/src/main/server/host-skills.ts`
- Modify: `apps/desktop/src/main/server/workspace-state.ts`
- Modify: `apps/desktop/src/shared/actions.ts`

**Interfaces:**
- Produces: `PersonalArtifactStore.ensureRoot/list/read/write/remove` scoped by profile and project.
- Produces: `PersonalArtifact { kind, name, absolutePath, projectRelativePath, provenance: "personal" }`.

- [ ] **Step 1: Write failing path and exclusion tests**

Create two profiles over one project. Assert each discovers only its own files, traversal names are rejected, `.git/info/exclude` contains exactly one `.catamorphic/personal/` rule, and no tracked `.gitignore` is created or edited.

- [ ] **Step 2: Run the focused desktop test and confirm the store is absent**

Run `bunx vitest run apps/desktop/src/main/personal-artifacts.test.ts --config apps/desktop/vitest.config.ts`.

- [ ] **Step 3: Implement validated local paths**

Resolve the project root through `ProjectManager`, validate profile ids and artifact names, use `realpath` containment checks for reads, and create only the requested kind directory. Update `.git/info/exclude` idempotently through a focused helper.

- [ ] **Step 4: Merge local discovery with provenance**

Project workflows, skills, documents, apps, and agents remain canonical results. Desktop-only consumers merge personal records and label them; core and remote APIs receive no personal path.

- [ ] **Step 5: Pass tests and inspect git status behavior**

Expected: files under the personal tree do not appear in project git status and another profile cannot discover them.

### Task 2: Add best-effort personal workflow invocation and sharing prompt

**Files:**
- Create: `apps/desktop/src/main/server/personal-workflow-invoker.ts`
- Create: `apps/desktop/src/main/server/personal-workflow-invoker.test.ts`
- Create: `apps/desktop/src/main/server/personal-capabilities.ts`
- Modify: `apps/desktop/src/main/server/agent-registry.ts`
- Create: `apps/desktop/src/renderer/components/personal-artifact-badge.tsx`
- Modify: `apps/desktop/src/renderer/screens/workflow-screen.tsx`
- Modify: `apps/desktop/src/renderer/components/command-palette.tsx`

**Interfaces:**
- Consumes: local runner, capability gateway, and `PersonalArtifactStore`.
- Produces: desktop-local `personal.workflow.invoke` and an “Ask agent to share with project” prompt action.

- [ ] **Step 1: Write failing local-only tests**

Invoke a personal workflow and assert no `workflow_runs`, deployment artifact, Allocation, or remote request is created. Reject any invocation carrying an Environment other than the desktop-local personal executor.

- [ ] **Step 2: Run focused tests and confirm no invoker exists**

Run the new invoker suite.

- [ ] **Step 3: Implement direct Bun development invocation**

Run the selected exported `defineWorkflow` through a desktop-local development harness with current files and explicit local connection scope. Return `PersonalInvocationResult` with `durability: "best_effort"`; do not call `RunsService`.

- [ ] **Step 4: Implement the sharing prompt only**

The action creates or focuses a coding-agent task with the artifact path and instructions to move it to canonical project locations, remove private assumptions, update dependencies/roles/connections/docs, and run repository checks. It performs no file move itself.

- [ ] **Step 5: Pass tests and verify provenance UI**

Expected: personal invocations are visibly local and best effort; the share action only submits an agent request.

### Task 3: Add durable schedules and wakeups

**Files:**
- Create: `packages/db/migrations/062_schedules_and_wakeups.sql`
- Modify: `packages/db/src/generated/db.ts`
- Create: `packages/core/src/services/schedule-types.ts`
- Create: `packages/core/src/services/schedules-service.ts`
- Create: `packages/core/src/services/schedule-worker.ts`
- Create: `packages/core/src/services/wakeups-service.ts`
- Create: `packages/core/src/__tests__/schedules-service.integration.test.ts`
- Create: `packages/core/src/__tests__/schedule-worker.integration.test.ts`
- Create: `packages/core/src/__tests__/wakeups-service.integration.test.ts`
- Modify: `packages/core/src/core.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Produces: `Schedule`, `ScheduleTiming`, `ScheduleMisfirePolicy`, `ScheduleOverlapPolicy`, `Wakeup`, and fenced schedule claims.

- [ ] **Step 1: Write failing schedule and wake tests**

Cover timezone calendar timing, intervals, unique occurrence ids, skip/run-once misfires, forbid/allow overlap, manual run-now, cancellation, member-enablement suspension, and one-shot wake consumption.

```ts
expect(dispatches.map((item) => item.occurrenceKey)).toEqual([
  `${scheduleId}:2026-08-25T06:00:00.000Z`,
]);
```

- [ ] **Step 2: Run focused tests and confirm tables/services are absent**

Run all three new core suites.

- [ ] **Step 3: Create migration 062**

Create `workflow_schedules` with enablement FK, timing JSONB, timezone, next occurrence, misfire/overlap policies, status, lease fence, last occurrence, and timestamps. Create `schedule_occurrences` with unique `(schedule_id, scheduled_for)` and resulting run id. Create `wakeups` with owner scope, target kind/id, due time, payload, status, lease fence, and terminal timestamps.

- [ ] **Step 4: Implement services and fenced workers**

Claim due rows with `FOR UPDATE SKIP LOCKED`, insert the occurrence before dispatch, revalidate the enablement, create a Run through `RunsService`, then record its id. A crash retries the same unique occurrence. Wakeups atomically transition pending to delivered once.

- [ ] **Step 5: Instrument and pass focused tests**

Use schedule/wakeup ids and outcomes as span attributes, never input payloads. Run migrations/codegen and all focused suites.

### Task 4: Expose canonical schedule/wake capabilities and local schedules

**Files:**
- Create: `packages/core/src/capabilities/schedule-capabilities.ts`
- Create: `packages/core/src/capabilities/wakeup-capabilities.ts`
- Create: `packages/fastify-plugin/src/routes/schedules.ts`
- Modify: `packages/fastify-plugin/src/schemas.ts`
- Modify: `packages/fastify-plugin/src/plugin.ts`
- Create: `packages/fastify-plugin/src/__tests__/schedules.integration.test.ts`
- Create: `apps/desktop/src/main/personal-schedules-store.ts`
- Create: `apps/desktop/src/main/personal-schedules-store.test.ts`
- Create: `apps/desktop/src/main/server/personal-schedule-capabilities.ts`
- Modify: `packages/claude-code/src/claude-code-agent.ts`
- Modify: `packages/codex/src/codex-agent.ts`

**Interfaces:**
- Produces: `schedule.create/list/get/update/delete/run_now`, `wake.create/list/cancel`, and desktop-local schedule records with `location: "this_desktop"`.

- [ ] **Step 1: Write capability parity and local schedule tests**

Require AI SDK, Claude, Codex, and MCP to list the same durable schedule schemas. Assert a personal schedule rejects an Environment, stores only profile-local state, and runs the current artifact file after an edit.

- [ ] **Step 2: Run focused tests and confirm capabilities are absent**

Run Fastify and desktop personal schedule suites.

- [ ] **Step 3: Register durable capabilities and typed routes**

All mutations flow through the gateway. Define Zod schemas first, register prefix-relative routes, and regenerate OpenAPI/client types. `schedule.create` requires an enablement id, never a workflow path.

- [ ] **Step 4: Implement desktop-local scheduling**

Persist profile/project/path/timing/next-run/status in the desktop profile store with no credentials or source copy. A desktop timer wakes, rereads the current artifact, and invokes the personal workflow harness. Sleep or downtime applies the explicit local misfire policy.

- [ ] **Step 5: Redirect provider-native scheduling**

Expose canonical schedule definitions to both harnesses. Disable or intercept provider-private schedule creation where supported. When a provider cannot intercept a private scheduler, set `nativeSchedulingIntercepted: false` in its descriptor and show the limitation rather than importing its state.

- [ ] **Step 6: Pass focused tests and regenerate APIs**

Expected: durable and personal schedules are distinct typed records and every harness reaches durable scheduling through one gateway implementation.

### Task 5: Complete desktop/PWA UI, docs, and end-to-end verification

**Files:**
- Create: `packages/react/src/hooks/use-schedules.ts`
- Create: `packages/react/src/hooks/use-wakeups.ts`
- Modify: `packages/react/src/index.ts`
- Create: `apps/desktop/src/renderer/components/schedules-panel.tsx`
- Create: `apps/desktop/src/renderer/components/schedule-card.tsx`
- Modify: `apps/desktop/src/renderer/components/catamorphic/chat-timeline.tsx`
- Modify: `apps/desktop/src/renderer/screens/workflow-screen.tsx`
- Modify: `apps/pwa/src/lib/api.ts`
- Modify: `apps/pwa/src/screens/chat-screen.tsx`
- Modify: `apps/pwa/src/components/catamorphic/chat-timeline.tsx`
- Create: `apps/pwa/src/components/schedules-panel.tsx`
- Modify: `apps/desktop/src/main/server/e2e-fakes.ts`
- Create: `apps/desktop/e2e/agent-capabilities.spec.ts`
- Modify: `INTEGRATION.md`
- Modify: `packages/server-sdk/README.md`
- Modify: `packages/claude-code/README.md`
- Modify: `packages/codex/README.md`
- Modify: `apps/desktop/DESIGN.md`

**Interfaces:**
- Consumes: all prior plans.
- Produces: host-replaceable hooks and complete reference-host vertical slices.

- [ ] **Step 1: Write the cross-surface e2e scenario**

The fake runtime emits approval, question, tool progress, process, provider task, Watch, and usage events. The test answers the request, attaches to the process, observes the Watch, creates a member schedule, sees owner/revision/Environment/next run, and distinguishes a personal workflow.

- [ ] **Step 2: Run the e2e test and capture the missing surfaces**

Run the single Playwright spec. Expected: FAIL on absent activity and schedule UI.

- [ ] **Step 3: Build normalized cards and hooks**

Render by event or record kind, not provider name. Schedule cards show owner, pinned commit, Environment, location, next occurrence, active/suspended state, update availability, and reauthorization action. Personal artifacts always show a Personal badge and local-only explanation.

- [ ] **Step 4: Add PWA request and schedule management**

The PWA can answer pending requests, inspect remote processes/Watches, and manage member-owned durable schedules. It does not expose desktop personal artifacts or personal schedules.

- [ ] **Step 5: Update embedding and harness documentation**

Document provider descriptors, capability registration/replacement, runner injection, workflow enablements, process/Watch APIs, durable schedule ownership, and local personal limitations. Record the desktop UI decisions in `apps/desktop/DESIGN.md`.

- [ ] **Step 6: Run the full approved verification matrix**

Run migrations/codegen, API generation twice, lint, typecheck, build, all tests, desktop e2e, and browser verification. Run `rg "ExtraTool|CodingAgentProvider|sendMessage\(|scheduled_tasks.json|codex-daemon" packages apps` and require no legacy implementation paths.

- [ ] **Step 7: Stop for final review**

Run `git diff --check` and inspect `git status --short`. Do not stage, commit, push, or create a PR without explicit user approval.
