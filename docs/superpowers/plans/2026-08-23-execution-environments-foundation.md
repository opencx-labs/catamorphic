# Execution Environments Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce project-facing execution Environments, role-gated admission, agent compatibility constraints, and immutable allocations for agent sessions and workflow runs using static single-node host bindings.

**Architecture:** Projects declare logical Environments in `.catamorphic/project.json`; hosts inject bindings that describe the actual trust, topology, capabilities, and resource ceiling. Core intersects project, identity, workload, and binding policy before recording an immutable allocation. Desktop and stock server each provide explicit single-node bindings, establishing the contracts that later credential and WorkerNode plans extend.

**Tech Stack:** TypeScript, Zod, Kysely/Postgres and PGlite migrations, Fastify/OpenAPI, React Query, Electron, Vitest, Turbo, Biome.

**Spec:** `docs/superpowers/specs/2026-08-23-execution-environments-design.md`

**Implementation status (2026-08-24):** Implemented and reviewed as part of
the combined Environment and credential cutover. The manual local exercise is
left to the repository owner after handoff.

## Global Constraints

- Make a hard greenfield cutover. Do not retain `SecretEnvironment`, secret API `environment` aliases, `AgentExecutionMode`, `execution: "host"`, or `hostAgentCheckout` compatibility shims.
- Environment means the logical project-facing policy. Physical machines are WorkerNodes; desktop remotes are ServerConnections.
- A project may narrow a host binding but may not supply endpoints, credentials, sandbox provider implementations, or wider permissions.
- Scoped identities require an explicit Environment grant. Project builder scope alone does not grant managed execution.
- Agent definitions declare compatibility requirements by default; exact Environment names are optional allowlists for exceptional cases.
- Environment policy participates in project-agent consent hashing.
- One agent session and one root workflow run resolve exactly one immutable Allocation. Child workflow runs inherit their root allocation.
- No secret or provider credential enters an Environment declaration, Allocation snapshot, API response, or sandbox.
- User-facing copy contains no em dashes or en dashes.
- Do not run `git add`, `git commit`, or `git push` without explicit user approval. Each task ends at a reviewable working-tree checkpoint.

---

### Task 1: Record the Environment architecture and remove overloaded terminology

**Files:**
- Create: `docs/decisions/0064-execution-environments-and-allocations.md`
- Modify: `docs/decisions/README.md`
- Modify: `docs/decisions/0033-user-declared-secrets.md`
- Modify: `docs/decisions/0038-coding-agent-registry-and-host-execution.md`
- Modify: `docs/decisions/0047-local-process-execution.md`
- Create: `packages/db/migrations/051_run_stage_terminology.sql`
- Modify: `packages/db/src/generated/db.ts`
- Modify: `packages/core/src/services/secrets-service.ts`
- Modify: `packages/core/src/services/run-plugins-loader.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/workflow/src/secrets.ts`
- Modify: `packages/fastify-plugin/src/schemas.ts`
- Modify: `packages/fastify-plugin/src/routes/plugins.ts`
- Modify: `packages/react/src/hooks/use-project-secrets.ts`
- Modify: `packages/react/src/hooks/use-upsert-project-secret.ts`
- Modify: `packages/react/src/hooks/use-delete-project-secret.ts`
- Test: `packages/core/src/__tests__/run-plugins-loader.test.ts`
- Test: `packages/react/src/hooks/__tests__/use-secrets.test.ts`

**Interfaces:**
- Produces: `RunStage = "test" | "production"`.
- Produces: secret service inputs with `stage: RunStage` and HTTP query `?stage=`.
- Consumes later: Environment APIs without collision with the old secret namespace.

- [ ] **Step 1: Add failing terminology tests**

Change the secret hook test to require `stage=test`, and add a type-level core fixture that imports `RunStage` while proving `SecretEnvironment` is no longer exported:

```ts
const stage: RunStage = "test";
expect(stage).toBe("test");
expect(new URL(request.url).searchParams.get("stage")).toBe("test");
```

- [ ] **Step 2: Run the focused tests and confirm the old API fails them**

Run:

```bash
bunx vitest run packages/core/src/__tests__/run-plugins-loader.test.ts packages/react/src/hooks/__tests__/use-secrets.test.ts --config vitest.config.ts
```

Expected: failures because the implementation and generated API still use `environment` and `SecretEnvironment`.

- [ ] **Step 3: Rename the database column with a forward-only migration**

Create migration 051:

```sql
ALTER TABLE project_secrets
  RENAME COLUMN environment TO stage;

ALTER TABLE project_secrets
  RENAME CONSTRAINT chk_project_secret_environment
  TO chk_project_secret_stage;
```

Postgres updates the existing `project_secrets_pkey` column reference when the
column is renamed, so no index replacement or data rewrite is needed.
Regenerate `packages/db/src/generated/db.ts`; do not hand-maintain a stale
generated type.

- [ ] **Step 4: Make the TypeScript and HTTP hard rename**

Use this exact public type and parameter name:

```ts
export type RunStage = "test" | "production";
```

Replace `environment: SecretEnvironment` with `stage: RunStage` through the secret service, run plugin loader, Fastify schemas/routes, React hooks, tests, comments, and generated API. Keep ordinary uses of “process environment” unchanged.

- [ ] **Step 5: Add ADR 0064 and mark refined decisions**

Record the approved Environment, binding, WorkerNode, Allocation, topology, role-grant, and credential-boundary decisions. Mark ADR 0033 as refined for `RunStage`, ADR 0038 as refined for topology naming, and ADR 0047 as refined because provider selection is now per Environment binding rather than globally inferred.

- [ ] **Step 6: Generate and verify the public API**

Run:

```bash
cd packages/fastify-plugin && bun run generate-spec
cd packages/api-client && bun run generate
cd ../.. && bun run db:migrate && bun run db:codegen
bunx vitest run packages/core/src/__tests__/run-plugins-loader.test.ts packages/react/src/hooks/__tests__/use-secrets.test.ts --config vitest.config.ts
```

Expected: migrations and code generation succeed; focused tests pass; generated schemas contain `stage` and no secret query named `environment`.

- [ ] **Step 7: Stop for review**

Review `git diff --check` and `git status --short`. Do not commit without explicit user approval.

### Task 2: Define vendor-neutral Environment and topology contracts

**Files:**
- Create: `packages/sandbox/src/execution-environment.ts`
- Modify: `packages/sandbox/src/index.ts`
- Modify: `packages/core/src/services/coding-agent-registry.ts`
- Modify: `packages/core/src/services/agent-sessions-service.ts`
- Modify: `packages/core/src/core.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/server-sdk/src/catamorphic.ts`
- Modify: `packages/server-sdk/src/index.ts`
- Modify: `apps/desktop/src/main/server/agent-registry.ts`
- Modify: `apps/desktop/src/main/server/boot.ts`
- Modify: `apps/desktop/src/main/server/coding-agent.ts`
- Modify: `apps/server/src/agents.ts`
- Test: `packages/sandbox/src/__tests__/execution-environment.test.ts`
- Test: `packages/core/src/__tests__/agent-sessions-service.test.ts`

**Interfaces:**
- Produces: `AgentExecutionTopology`, `EnvironmentBinding`, `EnvironmentRequirements`, `EnvironmentResourcePolicy`, `EnvironmentProvider`, and `environmentSatisfies(...)`.
- Produces: `RegisteredCodingAgent.topology` and `nativeAgentCheckout`.
- Consumes later: admission and allocation services.

- [ ] **Step 1: Write compatibility-matrix tests**

Cover trust, workload kind, topology, capabilities, and minimum resources:

```ts
expect(
  environmentSatisfies(binding, {
    workload: "agent",
    topology: "contained",
    trust: "managed",
    capabilities: ["network.egress", "browser"],
    resources: { memoryMb: 8192 },
  }),
).toEqual({ compatible: true });

expect(
  environmentSatisfies(binding, {
    workload: "agent",
    topology: "native",
  }),
).toEqual({
  compatible: false,
  reasons: ["Agent topology 'native' is not supported"],
});
```

- [ ] **Step 2: Run the new sandbox test and verify it fails**

Run:

```bash
bunx vitest run packages/sandbox/src/__tests__/execution-environment.test.ts --config vitest.config.ts
```

Expected: module-not-found failure for `execution-environment`.

- [ ] **Step 3: Add the neutral contracts**

Define these public shapes in `@catamorphic/sandbox`:

```ts
export type WorkloadKind = "agent" | "workflow";
export type EnvironmentTrust = "local" | "managed";
export type EnvironmentIsolation = "none" | "process" | "sandbox";
export type AgentExecutionTopology =
  | "controller"
  | "contained"
  | "native"
  | "external";

export interface EnvironmentResourcePolicy {
  cpuMillis?: number;
  memoryMb?: number;
  storageMb?: number;
  gpu?: boolean;
  timeoutSeconds?: number;
  maxConcurrency?: number;
}

export interface EnvironmentBinding {
  id: string;
  label: string;
  trust: EnvironmentTrust;
  isolation: EnvironmentIsolation;
  workloads: readonly WorkloadKind[];
  agentTopologies: readonly AgentExecutionTopology[];
  capabilities: readonly string[];
  resources: EnvironmentResourcePolicy;
}

export interface EnvironmentRuntimeBinding {
  descriptor: EnvironmentBinding;
  sandboxProvider?: SandboxProvider;
}

export interface EnvironmentRequirements {
  workload: WorkloadKind;
  topology?: AgentExecutionTopology;
  trust?: EnvironmentTrust;
  isolation?: EnvironmentIsolation;
  capabilities?: readonly string[];
  resources?: EnvironmentResourcePolicy;
}

export interface EnvironmentProvider {
  get(input: {
    tenantId: string;
    bindingId: string;
  }): Promise<EnvironmentRuntimeBinding | undefined> |
    EnvironmentRuntimeBinding | undefined;
}
```

Keep compatibility evaluation pure and deterministic. Treat requested numeric resources as minimums and binding values as ceilings. `gpu: true` requires true; false or absent does not reject a GPU binding.
The runtime binding is host-only. Project parsing and HTTP response code may
receive only `runtime.descriptor`; never serialize the provider object.

- [ ] **Step 4: Hard-rename agent execution concepts**

Replace:

```ts
execution: "sandbox" | "host";
hostAgentCheckout: HostAgentCheckout;
```

with:

```ts
topology: AgentExecutionTopology;
nativeAgentCheckout: NativeAgentCheckout;
```

Map existing behavior exactly: built-in AI SDK agents use `controller`; direct Claude Code and Codex agents use `native`. Reject `contained` and `external` with an explicit unsupported-topology error until their providers land.

- [ ] **Step 5: Run affected agent tests**

Run:

```bash
bunx vitest run packages/sandbox/src/__tests__/execution-environment.test.ts packages/core/src/__tests__/agent-sessions-service.test.ts apps/desktop/src/main/agents-store.test.ts --config vitest.config.ts
```

Expected: all focused tests pass with no remaining `execution: "host"` or `AgentExecutionMode` references under `packages/` or `apps/`.

- [ ] **Step 6: Stop for review**

Run `rg -n 'AgentExecutionMode|execution: "host"|hostAgentCheckout' packages apps`. Expected: no matches outside historical docs or migrations. Do not commit without explicit user approval.

### Task 3: Parse project Environments and expand role grants

**Files:**
- Create: `packages/core/src/services/project-environments-service.ts`
- Modify: `packages/core/src/services/roles-service.ts`
- Modify: `packages/core/src/identity.ts`
- Modify: `packages/core/src/core.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/src/seeds.ts`
- Modify: `apps/desktop/src/main/project-manifest.ts`
- Test: `packages/core/src/__tests__/project-environments.test.ts`
- Test: `packages/core/src/__tests__/roles.test.ts`
- Test: `apps/desktop/src/main/project-manifest.test.ts`

**Interfaces:**
- Produces: `ProjectEnvironmentDefinition`, `ProjectEnvironmentPolicy`, `ProjectEnvironmentsService.list(...)`, and `ProjectEnvironmentsService.get(...)`.
- Produces: `Identity.executionScope`, `ExecutionEnvironmentRef`, and `identityMayUseEnvironment(...)`.
- Consumes: `EnvironmentRequirements` from Task 2.

- [ ] **Step 1: Write failing manifest and role tests**

Use this project manifest fixture:

```json
{
  "environments": {
    "local": {
      "binding": "local",
      "description": "Run on this desktop",
      "workloads": ["agent", "workflow"]
    },
    "company": {
      "binding": "managed-standard",
      "workloads": ["agent", "workflow"]
    }
  },
  "defaultEnvironment": "local"
}
```

Assert invalid names, missing bindings, unknown defaults, duplicate values,
and unsupported workloads are reported as invalid project configuration. Add
`environments: ["company"]` to a role fixture and assert the resolved identity
can use `company` but not `local`, even when that role also has `builder: true`.

- [ ] **Step 2: Run tests and verify they fail**

Run:

```bash
bunx vitest run packages/core/src/__tests__/project-environments.test.ts packages/core/src/__tests__/roles.test.ts apps/desktop/src/main/project-manifest.test.ts --config vitest.config.ts
```

Expected: missing schema/service and missing role property failures.

- [ ] **Step 3: Add the project Environment schema and service**

Use the slug pattern already used by agents and roles. Define:

```ts
export interface ProjectEnvironmentDefinition {
  binding: string;
  description?: string;
  workloads: readonly WorkloadKind[];
  requirements?: Omit<EnvironmentRequirements, "workload" | "topology">;
}

export interface ProjectEnvironmentPolicy {
  environments: Readonly<Record<string, ProjectEnvironmentDefinition>>;
  defaultEnvironment?: string;
}
```

Read `.catamorphic/project.json` through the shared program reader, not a
desktop filesystem path. Return per-entry validation errors rather than
letting one malformed Environment make the entire project unreadable, but
report an invalid `defaultEnvironment` as a project-policy error.

- [ ] **Step 4: Add execution scope without widening artifact scope**

Extend identity with:

```ts
export interface ExecutionEnvironmentRef {
  projectId: string;
  name: string;
}

export interface Identity {
  tenantId: string;
  externalUserId: string;
  scope?: readonly ArtifactRef[];
  executionScope?: readonly ExecutionEnvironmentRef[];
}
```

`identityMayUseEnvironment` returns true for an unscoped root identity. For a
scoped identity it requires an exact `executionScope` match. Do not let a
`ProjectRef` imply Environment access.

- [ ] **Step 5: Extend role expansion**

Add `environments?: string[]` to `RoleDefinitionSchema`. Resolve placeholders
with the existing grant mechanism and populate `Identity.executionScope` in
`RolesService.resolve`. Deduplicate by `(projectId, name)`.

- [ ] **Step 6: Seed an explicit local Environment**

Update the default project manifest seed to contain a `local` declaration and
`defaultEnvironment: "local"`. Preserve host override through `projectSeeds`;
the framework must not hard-code a remote binding.

- [ ] **Step 7: Run focused tests**

Run the same three test files. Expected: all pass, including the assertion
that builder artifact scope does not widen Environment scope.

- [ ] **Step 8: Stop for review**

Run `git diff --check`. Do not commit without explicit user approval.

### Task 4: Resolve admission and persist immutable Allocations

**Files:**
- Create: `packages/db/migrations/052_execution_allocations.sql`
- Modify: `packages/db/src/generated/db.ts`
- Create: `packages/core/src/services/execution-environments-service.ts`
- Create: `packages/core/src/services/execution-allocations-service.ts`
- Modify: `packages/core/src/core.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/server-sdk/src/catamorphic.ts`
- Modify: `packages/server-sdk/src/index.ts`
- Test: `packages/core/src/__tests__/execution-environments.integration.test.ts`

**Interfaces:**
- Produces: `ExecutionEnvironmentsService.listCompatible(...)` and `admit(...)`.
- Produces: `ExecutionAllocation`, `ExecutionAllocationsService.create(...)`, `get(...)`, and `release(...)`.
- Consumes: project declarations, identity execution scope, and host bindings.

- [ ] **Step 1: Write failing admission tests**

Cover successful default resolution, explicit selection, role denial, missing
host binding, unsupported workload, topology mismatch, insufficient resources,
and deterministic preferred selection. Pin this failure shape:

```ts
await expect(
  environments.admit({
    identity: scopedMember,
    projectId,
    environment: "company",
    requirements: { workload: "agent", topology: "contained" },
  }),
).rejects.toMatchObject({
  name: "EnvironmentIncompatibleError",
  environment: "company",
  reasons: ["Agent topology 'contained' is not supported"],
});
```

- [ ] **Step 2: Add the allocation table**

Create migration 052 with this logical shape:

```sql
CREATE TABLE execution_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  environment_name text NOT NULL,
  binding_id text NOT NULL,
  workload_kind text NOT NULL CHECK (workload_kind IN ('agent', 'workflow')),
  root_workload_id uuid NOT NULL,
  worker_node_id text,
  policy_snapshot jsonb NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released')),
  created_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz
);

CREATE UNIQUE INDEX uq_execution_allocations_active_workload
  ON execution_allocations(workload_kind, root_workload_id)
  WHERE status = 'active';
```

Add indexes on `(project_id, environment_name, status)` and
`(tenant_id, status)`. The JSON snapshot contains public policy only and must
be parsed through a Zod schema on read.

- [ ] **Step 3: Implement deterministic admission**

`admit(...)` performs, in order: require project, read project declarations,
filter identity grants, filter workload type, load host bindings, merge
requirements, run `environmentSatisfies`, then choose explicit name, first
agent preference, project default, or lexicographically first compatible
Environment. An explicit incompatible choice fails and never falls back.

Return:

```ts
export interface EnvironmentAdmission {
  environmentName: string;
  binding: EnvironmentBinding;
  effectiveRequirements: EnvironmentRequirements;
}
```

- [ ] **Step 4: Implement immutable allocation persistence**

`create(...)` inserts the admission snapshot and returns:

```ts
export interface ExecutionAllocation {
  id: string;
  projectId: string;
  environmentName: string;
  bindingId: string;
  workloadKind: WorkloadKind;
  rootWorkloadId: string;
  workerNodeId: string | null;
  policy: EnvironmentAllocationPolicy;
  status: "active" | "released";
  createdAt: string;
  releasedAt: string | null;
}
```

Reject a second active allocation for the same root workload. `release`
changes only status and timestamp; an explicit agent move may then create a
new allocation while preserving the released allocation as history.

- [ ] **Step 5: Expose host injection through the server SDK**

Add required `environmentProvider: EnvironmentProvider` when either workflow
execution or a coding agent is configured. Read-only hosts may omit it. Fail
boot with a clear configuration error rather than synthesizing a binding.
Agent-session and workflow execution resolve their `SandboxProvider` from the
selected `EnvironmentRuntimeBinding`, not from the current global provider.
Keep the existing top-level provider only for app build surfaces until app
builds become an Environment workload in a separate plan, and document that
narrow remaining purpose explicitly.

- [ ] **Step 6: Run migration, codegen, and focused tests**

Run:

```bash
bun run db:migrate
bun run db:codegen
bunx vitest run packages/core/src/__tests__/execution-environments.integration.test.ts --config vitest.config.ts
```

Expected: migration and code generation succeed; all admission and immutability
tests pass.

- [ ] **Step 7: Stop for review**

Inspect the migration and generated types. Do not commit without explicit user approval.

### Task 5: Bind agent definitions and sessions to Environments

**Files:**
- Create: `packages/db/migrations/053_agent_session_allocations.sql`
- Modify: `packages/db/src/generated/db.ts`
- Modify: `packages/core/src/services/agent-definitions-service.ts`
- Modify: `packages/core/src/services/agent-sessions-service.ts`
- Modify: `packages/core/src/services/coding-agent-registry.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/fastify-plugin/src/schemas.ts`
- Modify: `packages/fastify-plugin/src/routes/agent.ts`
- Modify: `packages/react/src/hooks/use-create-agent-session.ts`
- Modify: `packages/react/src/hooks/use-agent-chat.ts`
- Test: `packages/core/src/__tests__/agent-definitions.integration.test.ts`
- Test: `packages/core/src/__tests__/agent-sessions-service.test.ts`
- Test: `packages/fastify-plugin/src/__tests__/agent-routes.test.ts`
- Test: `packages/react/src/hooks/__tests__/use-agent-chat.test.ts`

**Interfaces:**
- Produces: `AgentEnvironmentPolicy` on committed agents and `RegisteredCodingAgent.environment` for profile agents.
- Produces: session create input `environment?: string`, session response `environment` and `allocationId`.
- Consumes: admission and allocation services from Task 4.

- [ ] **Step 1: Write failing agent-policy tests**

Add this valid definition fixture:

```json
{
  "version": 1,
  "name": "Company Brain",
  "kind": "builtin",
  "environment": {
    "allowed": ["company", "gpu"],
    "preferred": ["company"],
    "requirements": {
      "trust": "managed",
      "capabilities": ["network.egress"],
      "resources": { "memoryMb": 8192 }
    }
  }
}
```

Assert `preferred` entries must be contained in `allowed`, duplicate names are
rejected, changes affect `definitionHash`, and a native registered provider is
rejected by an Environment that supports only controller agents.

- [ ] **Step 2: Add the agent policy schema**

Define:

```ts
export interface AgentEnvironmentPolicy {
  allowed?: readonly string[];
  preferred?: readonly string[];
  requirements?: Omit<EnvironmentRequirements, "workload" | "topology">;
}
```

The registry supplies topology; definitions cannot lie about it. Include the
policy in consent hashing and provider-cache invalidation. Profile agents use
the same structural field in `apps/desktop/src/main/agents-store.ts`.

- [ ] **Step 3: Link sessions to allocations**

Migration 053 adds a nullable `allocation_id` foreign key to
`agent_sessions`, preserving pre-cutover local chat history. New sessions must
always populate it; map historical nulls as `environment: null` and
`allocationId: null`, and do not allow a historical session to start another
turn until it is explicitly reallocated through the session update endpoint.
Generate the session UUID in core, perform admission, create the allocation,
and insert the new session and allocation in one database transaction.

- [ ] **Step 4: Apply allocation policy when anchoring the provider**

Use the recorded topology and Environment snapshot on every first-turn anchor.
`controller` retains the current dev-sandbox lifecycle; `native` uses
`nativeAgentCheckout`. Fail fast for `contained` and `external` until later
plans install a provider implementation. Never re-run admission on resume.

- [ ] **Step 5: Extend Fastify and React contracts**

Add `environment?: string` to `CreateAgentSessionSchema` and these required
response fields:

```ts
environment: z.string().nullable(),
allocationId: z.string().uuid().nullable(),
```

Map `EnvironmentAccessDeniedError`, `EnvironmentUnavailableError`, and
`EnvironmentIncompatibleError` to HTTP 403, 409, and 422 respectively, each
with a machine-readable error code and human-readable reasons.

- [ ] **Step 6: Preserve destination-owned allocation on mirror and fork**

Mirroring creates a new allocation using the destination project's default
and destination caller. It does not copy the source binding or WorkerNode.
Forking on the same control plane creates a fresh allocation using the parent
Environment preference, subject to current admission.

- [ ] **Step 7: Implement explicit session reallocation**

Allow `PATCH` to carry `environment`. Reject the change during a running turn.
Resolve admission against the current agent, release the current allocation,
create a replacement, clear the provider anchor and sandbox id, and update the
session's `allocation_id` atomically. The next turn re-anchors with persisted
history. This is also the recovery path for a historical session whose
allocation is null.

- [ ] **Step 8: Run focused tests and regenerate clients**

Run:

```bash
bun run db:migrate && bun run db:codegen
cd packages/fastify-plugin && bun run generate-spec
cd ../api-client && bun run generate
cd ../..
bunx vitest run packages/core/src/__tests__/agent-definitions.integration.test.ts packages/core/src/__tests__/agent-sessions-service.test.ts packages/fastify-plugin/src/__tests__/agent-routes.test.ts packages/react/src/hooks/__tests__/use-agent-chat.test.ts --config vitest.config.ts
```

Expected: focused tests pass; create-session clients accept Environment and
session payloads always include allocation identity.

- [ ] **Step 9: Stop for review**

Run `git diff --check`. Do not commit without explicit user approval.

### Task 6: Bind root workflow runs to Environments

**Files:**
- Create: `packages/db/migrations/054_workflow_run_allocations.sql`
- Modify: `packages/db/src/generated/db.ts`
- Modify: `packages/core/src/services/runs-service.ts`
- Modify: `packages/core/src/services/triggers-service.ts`
- Modify: `packages/core/src/services/execution-worker-service.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/server-sdk/src/scoped-client.ts`
- Modify: `packages/fastify-plugin/src/schemas.ts`
- Modify: `packages/fastify-plugin/src/routes/workflows.ts`
- Modify: `packages/fastify-plugin/src/routes/triggers.ts`
- Test: `packages/core/src/__tests__/runs-service.integration.test.ts`
- Test: `packages/core/src/__tests__/triggers-service.integration.test.ts`
- Test: `packages/fastify-plugin/src/__tests__/workflow-routes.test.ts`

**Interfaces:**
- Produces: `environment?: string` on `TriggerProductionRunInput` and `CallRunInput`.
- Produces: `Run.environment` and `Run.allocationId`.
- Consumes: the same admission and allocation services as agents.

- [ ] **Step 1: Write failing workflow admission tests**

Cover explicit Environment, project default, denied role, incompatible
workload, trigger-bound Environment, child inheritance, and restart behavior:

```ts
const run = await core.runs.triggerProduction({
  identity,
  projectId,
  workflowName: "onboard",
  environment: "company",
  input: { email: "new@example.com" },
});
expect(run).toMatchObject({ environment: "company" });
expect(run.allocationId).toMatch(UUID_PATTERN);
```

- [ ] **Step 2: Add the run allocation reference**

Migration 054 adds nullable `allocation_id` to `workflow_runs`, preserving
historical local runs. New root run enrollment always creates an Environment
allocation before queue insertion. Child runs copy their root's allocation id
and never create another allocation. Historical rows remain readable but
cannot be redriven until explicitly assigned a new allocation. Correlation-key
`ignore` returns the existing run and allocation; `restart` creates a new run
and new allocation after canceling the old run.

- [ ] **Step 3: Extend run admission APIs**

Add `environment?: string` to trigger and call inputs. Persist the caller's
scope exactly as today, plus the chosen allocation. Return `environment` and
`allocationId` from every run mapper and schema.

- [ ] **Step 4: Make triggers explicit and deterministic**

Trigger bindings may carry an optional project Environment name. When absent,
use the committed project default. A system-triggered run uses the trigger's
host-resolved identity and cannot borrow a member's Environment grant or
personal state. Existing trigger fire modes remain unchanged.

- [ ] **Step 5: Pass allocation context to execution**

Extend execution worker payload resolution so the run executor receives:

```ts
{
  allocationId: string;
  environmentName: string;
  bindingId: string;
  policy: EnvironmentAllocationPolicy;
}
```

Resolve the current `EnvironmentRuntimeBinding` by the allocation's binding id
and invoke that binding's `sandboxProvider`. Fail with an infrastructure error
when a workflow binding has no provider or the binding disappeared. Cache
sandbox managers and deployment-runtime services by binding id so two
Environments cannot accidentally share the wrong provider. Instrument every
distinct provider once. Do not choose a WorkerNode in the worker yet.

- [ ] **Step 6: Regenerate APIs and run focused tests**

Run migrations, DB codegen, Fastify spec generation, API client generation,
and the three focused test files. Expected: all pass and run payloads expose
Environment and Allocation consistently.

- [ ] **Step 7: Stop for review**

Run `git diff --check`. Do not commit without explicit user approval.

### Task 7: Wire explicit single-node bindings in desktop and stock server

**Files:**
- Create: `packages/server-sdk/src/static-environments.ts`
- Modify: `packages/server-sdk/src/index.ts`
- Modify: `packages/server-sdk/src/catamorphic.ts`
- Modify: `apps/desktop/src/main/server/boot.ts`
- Modify: `apps/desktop/src/main/server/e2e-fakes.ts`
- Modify: `apps/server/src/server.ts`
- Modify: `apps/server/src/server.test.ts`
- Test: `packages/server-sdk/src/static-environments.test.ts`

**Interfaces:**
- Produces: `defineStaticEnvironments(...)` implementing `EnvironmentProvider`.
- Consumes: host injection required by Task 4.

- [ ] **Step 1: Write failing static-provider tests**

Assert duplicate ids fail at construction, list results are immutable copies,
and tenant/project inputs are accepted without leaking one caller into another.

- [ ] **Step 2: Implement the static provider helper**

Use:

```ts
export function defineStaticEnvironments(
  bindings: readonly EnvironmentRuntimeBinding[],
): EnvironmentProvider;
```

Validate unique slug ids and at least one workload. Freeze normalized binding
descriptors without attempting to freeze host provider instances. Do not read
process environment variables or infer providers.

- [ ] **Step 3: Configure desktop bindings**

Register `local` with `trust: "local"`, the actual desktop sandbox isolation,
workloads `agent` and `workflow`, topologies `controller` and `native`, and no
service-credential capability. Attach the desktop's sandbox provider to that
runtime binding. E2E boot uses the same id with its fake provider.

- [ ] **Step 4: Configure stock-server binding**

Register `managed-single-node` with the stock server's actual local-process
isolation and supported controller topology. Do not claim `sandbox` isolation
when using `LocalProcessSandboxProvider`. Attach that provider to the runtime
binding. Seed stock-server projects so their logical default Environment binds
to this id.

- [ ] **Step 5: Run SDK and host tests**

Run:

```bash
bunx vitest run packages/server-sdk/src/static-environments.test.ts apps/server/src/server.test.ts --config vitest.config.ts
```

Expected: SDK and stock-server tests pass. Desktop fake wiring is exercised by
the desktop E2E scenario in Task 8 rather than through a test-only export.

- [ ] **Step 6: Stop for review**

Run `git diff --check`. Do not commit without explicit user approval.

### Task 8: Add Environment discovery and selection to API and desktop

**Files:**
- Create: `packages/fastify-plugin/src/routes/environments.ts`
- Modify: `packages/fastify-plugin/src/plugin.ts`
- Modify: `packages/fastify-plugin/src/schemas.ts`
- Create: `packages/react/src/hooks/use-environments.ts`
- Modify: `packages/react/src/index.ts`
- Modify: `packages/react/src/hooks/use-create-agent-session.ts`
- Modify: `apps/desktop/src/renderer/components/chat-dock.tsx`
- Modify: `apps/desktop/src/renderer/screens/workflow-screen.tsx`
- Modify: `apps/desktop/src/renderer/styles.css`
- Test: `packages/fastify-plugin/src/__tests__/environment-routes.test.ts`
- Test: `packages/react/src/hooks/__tests__/use-environments.test.ts`
- Test: `apps/desktop/e2e/agent-chat.spec.ts`

**Interfaces:**
- Produces: `GET /projects/:projectId/environments?workload=agent|workflow&agentId=`.
- Produces: environment picker data with compatibility and actionable reasons.
- Consumes: Task 4 discovery and Task 5/6 create inputs.

- [ ] **Step 1: Write failing route and hook tests**

Pin this response shape:

```ts
{
  items: [
    {
      name: "company",
      label: "Company",
      description: "Managed company execution",
      available: true,
      compatible: true,
      preferred: true,
      reasons: [],
      binding: {
        trust: "managed",
        isolation: "sandbox",
        capabilities: ["network.egress"]
      }
    }
  ],
  defaultEnvironment: "company"
}
```

The response never includes host endpoints, WorkerNode inventory, secret
names, credentials, or raw host configuration.

- [ ] **Step 2: Implement the Environment discovery route**

Resolve caller identity, project access, role grants, project declarations,
agent policy when `agentId` is provided, and host binding compatibility.
Return denied Environments only to project builders for diagnosis; scoped
members see only names they are granted.

- [ ] **Step 3: Implement the React hook**

Create:

```ts
export function useEnvironments(
  projectId: string | undefined,
  options: { workload: "agent" | "workflow"; agentId?: string },
): UseQueryResult<EnvironmentList>;
```

Include workload and agent id in the query key. Disable the query without a
project id.

- [ ] **Step 4: Add compact desktop selectors**

New chats default silently when exactly one compatible Environment exists.
When several exist, show the selected Environment beside the agent control
and allow changing it before the first message. Existing allocated sessions
show a read-only Environment label.

The workflow screen shows an Environment selector before manual Run and Call
actions. Disabled entries show the first compatibility reason. Do not expose
WorkerNode selection.

- [ ] **Step 5: Verify desktop behavior**

Add an E2E case with `local` and `company`: choose `company`, create a session,
assert the session payload and visible badge use `company`, then verify the
selector becomes read-only after the first allocation.

- [ ] **Step 6: Generate clients and run focused tests**

Run Fastify spec generation, API client generation, route tests, hook tests,
and the focused desktop E2E case. Expected: all pass with zero browser console
errors.

- [ ] **Step 7: Stop for review**

Run `git diff --check`. Do not commit without explicit user approval.

### Task 9: Update public documentation and run the complete verification gate

**Files:**
- Modify: `INTEGRATION.md`
- Modify: `apps/desktop/DESIGN.md`
- Modify: `apps/server/README.md`
- Modify: `packages/plugins/README.md`
- Modify: `packages/core/src/seeds.ts`
- Modify: `docs/decisions/README.md`

**Interfaces:**
- Consumes: every public contract from Tasks 1 through 8.
- Produces: embedding and product guidance for Environment configuration.

- [ ] **Step 1: Document the host contract**

Add complete examples for `defineStaticEnvironments`, desktop local binding,
stock server binding, project manifest declarations, role Environment grants,
agent requirements, session creation, workflow triggering, and the distinction
between Environment, binding, WorkerNode, and ServerConnection.

- [ ] **Step 2: Document security invariants**

State explicitly that projects cannot provide physical endpoints or widen host
policy, builders do not implicitly receive managed Environment access,
allocations contain no credentials, and future service connections remain
brokered outside sandboxes.

- [ ] **Step 3: Run formatting and static checks**

Run:

```bash
bun run lint
bun run typecheck
```

Expected: zero warnings and zero errors.

- [ ] **Step 4: Run build and tests**

Run:

```bash
bun run build
bun run test
```

Expected: every package builds and every test passes.

- [ ] **Step 5: Run database and API synchronization checks**

Run:

```bash
bun run db:migrate
bun run db:codegen
cd packages/fastify-plugin && bun run generate-spec
cd ../api-client && bun run generate
cd ../..
git diff --check
git status --short
```

Expected: generators are idempotent, `git diff --check` is clean, and status
contains only the reviewed Environment implementation and documentation.

- [ ] **Step 6: Run desktop verification**

Follow `apps/desktop/AGENTS.md`: rebuild affected packages, launch the desktop
host, run its required E2E suite, exercise one agent session and one workflow
run in the local Environment, and confirm zero renderer console errors.

- [ ] **Step 7: Stop for final review**

Summarize changed contracts, migrations, verification output, and remaining
follow-on plans. Do not commit or push without explicit user approval.

## Follow-on plans

The foundation originally separated these independently reviewable
subsystems. The current status is:

1. **Credential broker and authentication admission:** implemented by ADR
   0065 and the credential connections plan. Personal owner-bound unattended
   delegation is intentionally deferred in
   `docs/todos/owner-bound-unattended-delegation.md`.
2. **Contained agent execution:** agent process inside the allocation sandbox,
   model gateway, capability gateway, event transport, interruption, and
   credential-free provider compatibility.
3. **WorkerNode pools:** registration, descriptors, heartbeats, draining,
   placement leases, capacity scheduling, affinity, recovery, and version
   coordination.

The remaining follow-ons receive their own spec amendment and implementation
plan after the foundation contracts have been exercised in production-like
local tests.
