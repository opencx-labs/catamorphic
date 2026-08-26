# Workflow Enablement and Member Delegation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow committed workflows to run unattended under explicit member or service authority with exact connections, durable consent, suspension, and pinned revisions.

**Architecture:** A `workflow_enablements` table separates runtime authority from workflow code and trigger projections. Core validates an enablement at creation, every dispatch, and every broker call. Trigger bindings reference enablements; interactive member Runs continue to use live member admission without creating one.

**Tech Stack:** TypeScript, Zod, Kysely/Postgres and PGlite, Fastify/OpenAPI, React Query, Vitest, OpenTelemetry.

**Spec:** `docs/superpowers/specs/2026-08-24-agent-runtime-capabilities-and-personal-artifacts-design.md`

## Global Constraints

- There is no workflows table; identify workflow code by project, workflow name, deployment artifact, and commit.
- An unattended dispatch requires one active enablement.
- Member and service authority use the same record and validation path.
- Exact connection ids never fall back to another connection.
- New deployments set `updateAvailable`; they do not change the pinned deployment.
- Every broker call revalidates current membership, Environment, connection, capability, and credential status.
- Do not stage or commit without explicit user approval.

---

### Task 1: Add the enablement schema and domain types

**Files:**
- Create: `packages/db/migrations/059_workflow_enablements.sql`
- Modify: `packages/db/src/generated/db.ts`
- Create: `packages/core/src/services/workflow-enablement-types.ts`
- Create: `packages/core/src/__tests__/workflow-enablement-schema.integration.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Produces: `WorkflowEnablement`, `WorkflowEnablementOwner`, `WorkflowEnablementStatus`, `WorkflowEnablementConnection`, and persisted consent digest.

- [ ] **Step 1: Write failing schema integration tests**

Insert two member enablements for the same workflow/deployment and assert both succeed; reject an owner row with neither member nor service identity; reject connection aliases duplicated inside one enablement.

```ts
expect(first.owner).toEqual({ type: "member", externalUserId: "member-a" });
expect(second.owner).toEqual({ type: "member", externalUserId: "member-b" });
```

- [ ] **Step 2: Run the schema test and confirm the table is absent**

Run `bunx vitest run packages/core/src/__tests__/workflow-enablement-schema.integration.test.ts --config vitest.config.ts`.

- [ ] **Step 3: Create migration 059**

Create `workflow_enablements` with tenant/project, workflow name, deployment artifact FK, commit SHA, Environment, owner kind, member external id or service principal reference, JSONB narrowed capabilities, consent digest, status, suspension reason, update-available boolean, timestamps, and revision. Create `workflow_enablement_connections` with enablement FK, alias, binding id, exact connection id, principal kind, and capability snapshot. Add owner-shape checks and indexes for project/workflow, owner, active status, and deployment.

- [ ] **Step 4: Add exact public domain types**

```ts
export type WorkflowEnablementStatus = "active" | "suspended" | "disabled";
export type WorkflowEnablementOwner =
  | { type: "member"; externalUserId: string }
  | { type: "service"; principalKind: "project_service" | "tenant_service"; connectionId: string };
```

Represent `updateAvailable` independently from status.

- [ ] **Step 5: Migrate, codegen, and pass the schema test**

Run `bun run db:migrate && bun run db:codegen`, then the focused suite. Expected: PASS and generated DB types include both tables.

### Task 2: Implement enablement lifecycle and consent

**Files:**
- Create: `packages/core/src/services/workflow-enablements-service.ts`
- Create: `packages/core/src/services/workflow-enablement-consent.ts`
- Create: `packages/core/src/__tests__/workflow-enablements-service.integration.test.ts`
- Modify: `packages/core/src/core.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: deployments, parser projections, Environment admission, connection admission, Identity.
- Produces: `create/list/get/disable/reenable/updateDeployment/suspend/revalidate` methods.

- [ ] **Step 1: Write lifecycle tests before the service**

Cover member creation, service creation, missing durable consent, cross-member denial, connection mismatch, suspension after role removal, reenable after reauthorization, and explicit deployment update.

```ts
await expect(
  service.updateDeployment({ identity: memberB, enablementId, deploymentArtifactId: nextId }),
).rejects.toThrow(AccessDeniedError);
```

- [ ] **Step 2: Run the focused suite and confirm missing service exports**

Run the new integration suite.

- [ ] **Step 3: Implement deterministic consent hashing**

Hash canonical JSON containing project id, workflow name, deployment artifact digest, Environment, owner, sorted exact connection aliases/ids, and sorted narrowed capabilities. Do not include display labels or timestamps.

- [ ] **Step 4: Implement lifecycle methods with transactions and spans**

Creation resolves the deployed workflow's constant requirements, validates the caller and exact connections, and inserts the enablement plus connection rows atomically. `updateDeployment` reruns all checks and requires a matching fresh consent digest. `revalidate` returns a typed reason and suspends atomically when invalid.

- [ ] **Step 5: Pass lifecycle tests**

Expected: removing one member suspends only that member's enablement; another member and service enablement stay active.

### Task 3: Enforce enablements at dispatch and broker call time

**Files:**
- Modify: `packages/core/src/services/connection-admission.ts`
- Modify: `packages/core/src/services/connection-broker.ts`
- Modify: `packages/core/src/services/boundary-execution-handler.ts`
- Modify: `packages/core/src/services/runs-service.ts`
- Create: `packages/core/src/__tests__/workflow-enablement-dispatch.integration.test.ts`
- Modify: `packages/core/src/__tests__/runs-service.integration.test.ts`

**Interfaces:**
- Consumes: `WorkflowEnablementsService.revalidate` and exact connection rows.
- Produces: unattended Run caller scope carrying `workflowEnablementId`; broker calls require that scope.

- [ ] **Step 1: Write dispatch and mid-run revocation tests**

Dispatch an active member enablement, revoke its exact connection before a boundary call, and assert the run parks with a typed authorization requirement while the enablement becomes suspended. Assert no other ready connection is selected.

- [ ] **Step 2: Run focused tests and observe snapshot-only behavior**

Run the new dispatch suite and existing Runs suite.

- [ ] **Step 3: Add enablement-bound caller scope**

Persist the enablement id and owner snapshot on the root Run. Child workflows inherit it. Interactive Runs keep their current member caller scope and omit an enablement id.

- [ ] **Step 4: Revalidate at both boundaries**

Before creating an unattended Run, call `revalidate`. In `ConnectionBroker.invoke`, load the exact alias row from the enablement, recheck connection ownership/status and live capability intersection, and suspend on failure. Never call general connection resolution for an enablement-bound alias.

- [ ] **Step 5: Pass focused tests**

Expected: dispatch and broker revalidation are independently effective, and durable boundary parking remains resumable after reauthorization.

### Task 4: Make trigger projections reference enablements

**Files:**
- Create: `packages/db/migrations/060_trigger_definitions_and_activations.sql`
- Modify: `packages/core/src/services/triggers-service.ts`
- Modify: `packages/core/src/services/trigger-codegen.ts`
- Modify: `packages/core/src/__tests__/triggers-service.integration.test.ts`
- Modify: `packages/db/src/generated/db.ts`

**Interfaces:**
- Consumes: workflow enablement lifecycle and trigger projections.
- Produces: trigger bindings that remain code projections while runtime activation is an enablement reference.

- [ ] **Step 1: Rewrite trigger tests around inert projections**

Scanning a commit creates trigger definitions but firing without an active matching enablement returns `TriggerNotEnabledError`. Two member enablements may attach distinct trigger instances without changing workflow code.

- [ ] **Step 2: Run trigger tests and confirm current binding-is-enablement behavior fails**

Run `packages/core/src/__tests__/triggers-service.integration.test.ts`.

- [ ] **Step 3: Split projection from activation in migration 060**

Create forward migration 060. Rename existing `trigger_bindings` to `trigger_definitions`, retain commit-derived fields, and remove Environment and authorization snapshot columns. Create `workflow_enablement_triggers` with enablement id, trigger definition id, host trigger key, configuration overlay, status, and unique ownership key.

- [ ] **Step 4: Rewrite trigger scan and fire paths**

Scanning only updates definitions. Enabling validates that the definition belongs to the enablement's pinned commit. Firing resolves the activation, revalidates its enablement, and creates the Run with that enablement id.

- [ ] **Step 5: Regenerate DB types and pass trigger tests**

Run migrations/codegen and the trigger suite. Expected: project code remains the definition source; database state only activates it.

### Task 5: Add typed API, hooks, and enablement UI

**Files:**
- Create: `packages/fastify-plugin/src/routes/workflow-enablements.ts`
- Modify: `packages/fastify-plugin/src/schemas.ts`
- Modify: `packages/fastify-plugin/src/plugin.ts`
- Create: `packages/fastify-plugin/src/__tests__/workflow-enablements.integration.test.ts`
- Modify: `packages/api-client/src/schema.d.ts`
- Create: `packages/react/src/hooks/use-workflow-enablements.ts`
- Create: `packages/react/src/hooks/use-create-workflow-enablement.ts`
- Create: `packages/react/src/hooks/use-update-workflow-enablement.ts`
- Modify: `packages/react/src/index.ts`
- Create: `apps/desktop/src/renderer/components/workflow-enablement-panel.tsx`
- Modify: `apps/desktop/src/renderer/screens/workflow-screen.tsx`

**Interfaces:**
- Consumes: `WorkflowEnablementsService`.
- Produces: list/create/get/disable/reenable/update-deployment endpoints and “Enable for me” UI.

- [ ] **Step 1: Write failing route and component tests**

Assert a member sees only permitted enablements, creation returns exact selected connections, the panel labels owner and Environment, and an update-available enablement continues to show its pinned commit.

- [ ] **Step 2: Run focused tests and confirm routes/components are absent**

Run the new Fastify suite and desktop component test.

- [ ] **Step 3: Define Zod schemas before routes**

Create discriminated owner schemas, exact connection selections, capability arrays, consent digest, status, suspension reason, pinned deployment, and update flag. Register prefix-relative routes under `/projects/:projectId/workflow-enablements...`.

- [ ] **Step 4: Generate OpenAPI/client and implement hooks**

Run spec and API client generation before writing hooks. Hooks must consume generated path types and invalidate project workflow-enablement keys after mutations.

- [ ] **Step 5: Implement the desktop flow**

The panel selects an Environment and exact member connections, renders the durable-consent summary, and provides enable, disable, reauthenticate, and explicit update actions. Never display raw provider scopes as if they were project capabilities.

- [ ] **Step 6: Verify the sub-plan**

Run focused tests, migrations/codegen, API generation, lint, typecheck, build, full tests, and `git diff --check`. Stop at a reviewable working-tree checkpoint.
