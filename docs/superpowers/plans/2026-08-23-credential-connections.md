# Credential Connections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a host-side credential and connection system that supports member and service principals, Environment-specific authorization, pre-allocation auth admission, durable workflow actions, brokered agent MCP tools, role-aware policy, revocation, and audit without giving provider secrets to sandboxes.

**Architecture:** Hosts inject an opaque credential vault and connection providers. Projects and workloads refer to Environment-local connection aliases. Core resolves the caller, Environment, binding, principal, and strictest policy before allocation, then issues an allocation-bound capability grant. Workflow connection calls and agent MCP tools cross a control-plane broker that alone opens provider credentials. Reference hosts implement encrypted vaults and authorization UI; the generic remote-MCP provider reuses `@catamorphic/mcp` OAuth.

**Tech Stack:** TypeScript, Zod, Kysely/Postgres and PGlite, Fastify/OpenAPI, MCP, Electron `safeStorage`, Node crypto, React Query, Vitest, Turbo, Biome.

**Depends on:** `docs/superpowers/plans/2026-08-23-execution-environments-foundation.md`

**Spec:** `docs/superpowers/specs/2026-08-23-credential-connections-design.md`

**Implementation status (2026-08-24):** Implemented and reviewed with the
greenfield simplifications in ADR 0066. Unattended member delegation is
deferred in `docs/todos/owner-bound-unattended-delegation.md`. The repository
owner will perform the final real-provider local exercise after handoff.

## Global Constraints

- Never return or inject provider credential material through a public SDK, API response, Allocation, run environment, session metadata, log, span, sandbox, or agent harness config.
- Use one connection and policy model for agent MCP tools and workflow direct actions.
- Member, project-service, and tenant-service principals are explicit. Unattended work cannot implicitly borrow a member connection.
- Admission must return structured authentication requirements before creating an Allocation or starting compute.
- Project files may declare requirements and narrow use. Only a host administrator may configure service identities, OAuth clients, vaults, provider endpoints, and policy ceilings.
- Existing `project_secrets` remain workflow configuration and are not used for external provider credentials.
- All new service and SDK methods take one keyed object parameter.
- Provider calls are host-side and caller-bound. No workflow input may claim an identity or connection id.
- User-facing copy contains no em dashes or en dashes.
- Do not add Slack or Google client secrets to fixtures. Vendor provider tests use deterministic fake drivers and sanitized metadata.
- Do not run `git add`, `git commit`, or `git push` without explicit user approval.

---

### Task 1: Record the credential architecture and introduce vault contracts

**Files:**
- Create: `docs/decisions/0065-credential-connections-and-capability-broker.md`
- Modify: `docs/decisions/README.md`
- Modify: `docs/decisions/0033-user-declared-secrets.md`
- Modify: `docs/decisions/0046-plugin-activation-planes.md`
- Modify: `docs/decisions/0054-tool-permissions.md`
- Modify: `docs/decisions/0055-company-brain-roles-store-and-change-loop.md`
- Create: `packages/core/src/services/credential-vault.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/server-sdk/src/catamorphic.ts`
- Modify: `packages/server-sdk/src/index.ts`
- Test: `packages/core/src/__tests__/credential-vault.test.ts`

**Interfaces:**
- Produces: `CredentialVault`, `CredentialRef`, `CredentialMaterial`, and a memory-only test vault.
- Consumes later: connection lifecycle and providers.

- [ ] **Step 1: Add failing vault contract tests**

Require tenant-qualified put, read-with-callback, replace, and delete behavior. Prove the public result contains only a reference and that buffers handed to the callback are zeroed or discarded after the callback.

- [ ] **Step 2: Run the focused test and confirm the module is absent**

```bash
bunx vitest run packages/core/src/__tests__/credential-vault.test.ts --config vitest.config.ts
```

- [ ] **Step 3: Implement the host-injected opaque vault seam**

Use keyed object parameters and a callback-based read so normal core service code cannot casually retain plaintext:

```ts
export interface CredentialVault {
  put(args: { tenantId: string; material: Uint8Array }): Promise<CredentialRef>;
  replace(args: { tenantId: string; ref: CredentialRef; material: Uint8Array }): Promise<void>;
  withMaterial<T>(args: {
    tenantId: string;
    ref: CredentialRef;
    use: (material: Uint8Array) => Promise<T> | T;
  }): Promise<T>;
  delete(args: { tenantId: string; ref: CredentialRef }): Promise<void>;
}
```

Require `credentialVault` only when connection providers are configured so embedders not using connections remain source-compatible.

- [ ] **Step 4: Record ADR 0065**

Record principal types, Environment bindings, vault ownership, brokered invocation, 428 admission, unattended behavior, capability grants, and audit. Mark ADR 0033 as not suitable for provider identities, ADR 0046 as superseded for secret-bearing env injection, and ADRs 0054/0055 as extended by the broker.

- [ ] **Step 5: Run focused tests and diff checks**

```bash
bunx vitest run packages/core/src/__tests__/credential-vault.test.ts --config vitest.config.ts
git diff --check
```

### Task 2: Persist connection metadata, bindings, attachments, auth attempts, grants, and audit

**Files:**
- Create: `packages/db/migrations/055_credential_connections.sql`
- Modify: `packages/db/src/generated/db.ts`
- Create: `packages/core/src/services/connection-types.ts`
- Create: `packages/core/src/services/connections-service.ts`
- Modify: `packages/core/src/core.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/__tests__/connections-service.integration.test.ts`

**Interfaces:**
- Produces: Connections, EnvironmentConnectionBindings, MemberConnectionAttachments, AuthorizationAttempts, CapabilityGrants, ConnectionAuditEvents.
- Consumes: Environment and Allocation records from the foundation.

- [ ] **Step 1: Write failing lifecycle and isolation integration tests**

Cover member, project-service, and tenant-service metadata; tenant isolation; explicit service assignments; one member attachment per project/Environment/alias; sanitized public records; hashed authorization state and capability tokens; append-only audit; and cascading grant revocation.

- [ ] **Step 2: Run the focused integration test**

```bash
bunx vitest run packages/core/src/__tests__/connections-service.integration.test.ts --config vitest.config.ts
```

- [ ] **Step 3: Add forward-only schema**

Create normalized tables:

- `connections`
- `environment_connection_bindings`
- `member_connection_attachments`
- `connection_authorization_attempts`
- `connection_capability_grants`
- `connection_audit_events`

Store `credential_ref`, never credential bytes. Use JSONB only for typed capability, scope, policy, account-summary, and immutable audit metadata. Add tenant/project foreign keys, partial uniqueness for principal ownership, expiry indexes, and status checks. Store only SHA-256 hashes for OAuth state and capability bearer tokens.

- [ ] **Step 4: Implement sanitized lifecycle services**

Add create/update/list/get/attach/detach/revoke methods with identity and tenant checks. Service connection creation and assignment require `connections:manage_service` in host-supplied control-plane permissions. Member authorization can mutate only the caller's own attachment.

- [ ] **Step 5: Migrate, codegen, and rerun tests**

```bash
bun run db:migrate
bun run db:codegen
bunx vitest run packages/core/src/__tests__/connections-service.integration.test.ts --config vitest.config.ts
```

### Task 3: Define connection providers and the remote-MCP provider

**Files:**
- Create: `packages/core/src/services/connection-providers.ts`
- Modify: `packages/core/src/core.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/server-sdk/src/define-plugin.ts`
- Modify: `packages/server-sdk/src/index.ts`
- Create: `packages/mcp/src/connection-provider.ts`
- Modify: `packages/mcp/src/oauth.ts`
- Modify: `packages/mcp/src/index.ts`
- Test: `packages/core/src/__tests__/connection-providers.test.ts`
- Test: `packages/mcp/src/__tests__/connection-provider.test.ts`

**Interfaces:**
- Produces: `ConnectionProvider`, `ConnectionProviderRegistry`, authorization challenges, refresh/revoke, direct actions, MCP list/call, and `McpConnectionProvider`.
- Consumes: `CredentialVault` and existing MCP OAuth/client infrastructure.

- [ ] **Step 1: Add failing provider registry and fake-provider tests**

Cover duplicate kinds, missing operations, sanitized account metadata, credential replacement, refresh races, provider errors, and a provider result that attempts to return secret material.

- [ ] **Step 2: Add failing MCP provider tests**

Use a local fake MCP server to cover unauthenticated use, OAuth-required challenge, stored OAuth state, refresh, tool annotations, and tool invocation without exposing bearer headers through the provider's public result.

- [ ] **Step 3: Implement provider contracts and registry**

Keep provider credential access behind a host-only `CredentialHandle`. Define authorization challenge kinds `url`, `device`, and `form`; the public form carries field metadata but never saved values.

- [ ] **Step 4: Refactor MCP OAuth for host-driven redirects**

Separate protocol state from the desktop-only loopback listener. Preserve the loopback helper for desktop while exposing begin and complete operations usable by a remote Fastify callback. Support MCP dynamic client registration and pre-registered client hints through the same provider.

- [ ] **Step 5: Expose providers through host plugins**

Allow `definePlugin({ connections: [...] })`; merge providers at boot and fail on duplicate kind names.

- [ ] **Step 6: Run provider tests**

```bash
bunx vitest run packages/core/src/__tests__/connection-providers.test.ts packages/mcp/src/__tests__/connection-provider.test.ts --config vitest.config.ts
```

### Task 4: Add role-scoped Environment bindings and connection requirements

**Files:**
- Modify: `packages/core/src/identity.ts`
- Modify: `packages/core/src/services/roles-service.ts`
- Modify: `packages/core/src/services/agent-definitions-service.ts`
- Modify: `packages/core/src/services/agent-consent-service.ts`
- Modify: `packages/fastify-plugin/src/schemas.ts`
- Test: `packages/core/src/__tests__/identity.test.ts`
- Test: `packages/core/src/__tests__/roles-service.test.ts`
- Test: `packages/core/src/__tests__/agent-definitions.test.ts`

**Interfaces:**
- Produces: `ConnectionRequirement`, role connection refs, control-plane connection permissions, and strict intersection helpers.
- Consumes: Environment grants and agent definitions from the foundation.

- [ ] **Step 1: Add failing role and requirement tests**

Cover alias, Environment, principal kinds, capability patterns, tool policy, placeholders, builder-without-connection-grant, and strict narrowing. Cover structured agent requirements and the string shorthand.

- [ ] **Step 2: Add connection scope to Identity**

Add caller-use scope separately from host management permissions. `narrowIdentity` must intersect connection refs. A scoped identity with no matching ref receives no connection use even if a service binding exists.

- [ ] **Step 3: Extend project role parsing**

Parse `connections` refs from committed role files. Keep secrets and concrete connection ids invalid in role files.

- [ ] **Step 4: Extend agent definitions and consent hashing**

Accept `connections: (string | ConnectionRequirement)[]`. Include alias, principal, capabilities, optionality, and Environment restriction in the consent hash. Exclude policy-only narrowing as established by ADR 0054.

- [ ] **Step 5: Run focused scope tests**

```bash
bunx vitest run packages/core/src/__tests__/identity.test.ts packages/core/src/__tests__/roles-service.test.ts packages/core/src/__tests__/agent-definitions.test.ts --config vitest.config.ts
```

### Task 5: Implement the connection broker and pre-allocation admission

**Files:**
- Create: `packages/core/src/services/connection-broker.ts`
- Create: `packages/core/src/services/connection-admission.ts`
- Modify: `packages/core/src/services/environment-admission-service.ts`
- Modify: `packages/core/src/services/allocations-service.ts`
- Modify: `packages/core/src/services/agent-sessions-service.ts`
- Modify: `packages/core/src/services/runs-service.ts`
- Modify: `packages/core/src/services/triggers-service.ts`
- Modify: `packages/core/src/core.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/__tests__/connection-admission.integration.test.ts`
- Test: `packages/core/src/__tests__/connection-broker.integration.test.ts`

**Interfaces:**
- Produces: `AuthenticationRequiredError`, `ConnectionUnavailableError`, `ConnectionAuthorizationExpiredError`, resolved binding snapshots, and broker calls.
- Consumes: Identity, Environment selection, requirements, providers, vault, and Allocation service.

- [ ] **Step 1: Write failing admission matrix tests**

Prove:

- missing member auth returns typed requirements and creates no Allocation;
- a ready member attachment proceeds;
- a required service principal never falls back to a member;
- unattended runs never pick a personal connection implicitly;
- unattended member auth is rejected; only service auth can proceed;
- trust or isolation mismatch rejects before allocation;
- all policy layers narrow capabilities and tool permissions;
- revoked or expired connections stop the next call.

- [ ] **Step 2: Write failing broker tests**

Assert caller, project, Environment, Allocation, artifact, and action are bound server-side; vault material is visible only inside the fake provider; output is sanitized; provider calls are audited; arguments are represented only by a digest; and denial is checked on every invocation.

- [ ] **Step 3: Implement admission before allocation**

Make session and root-run creation call Environment admission, then connection admission, then Allocation creation in that order. Roll back or create nothing on failure. Child runs inherit the root's resolved bindings.

- [ ] **Step 4: Implement broker resolution and strictest-policy enforcement**

Resolve aliases from the Allocation snapshot, not mutable client input. Re-check live status, role scope, grant status, and policy on every call. Refresh expiring credentials through the provider with revision-safe replacement.

- [ ] **Step 5: Enforce unattended trigger configuration**

Validate connection resolution when a trigger binding is enabled. Persist the exact service connection ids in the trigger's authorization snapshot. Never infer a member during dispatch.

- [ ] **Step 6: Run focused tests**

```bash
bunx vitest run packages/core/src/__tests__/connection-admission.integration.test.ts packages/core/src/__tests__/connection-broker.integration.test.ts --config vitest.config.ts
```

### Task 6: Add workflow declarations and durable connection calls

**Files:**
- Modify: `packages/workflow/src/workflow.ts`
- Modify: `packages/workflow/src/context.ts`
- Modify: `packages/workflow/src/index.ts`
- Modify: `packages/runtime/src/context-calls.ts`
- Modify: `packages/runtime/src/supervisor-protocol.ts`
- Modify: `packages/runtime/src/supervisor-worker.ts`
- Modify: `packages/parser/src/types.ts`
- Modify: `packages/parser/src/parser.ts`
- Modify: `packages/parser/src/execution-transform.ts`
- Modify: `packages/core/src/services/deployment-artifacts-service.ts`
- Modify: `packages/core/src/services/boundary-execution-handler.ts`
- Modify: `packages/core/src/seeds.ts`
- Test: `packages/workflow/src/__tests__/workflow.test.ts`
- Test: `packages/runtime/src/__tests__/context-calls.test.ts`
- Test: `packages/parser/src/__tests__/project-parser.test.ts`
- Test: `packages/core/src/__tests__/connection-calls.integration.test.ts`

**Interfaces:**
- Produces: workflow `connections` metadata and `context.connections.<alias>.<action>(args)` durable transitions.
- Consumes: broker and connection admission.

- [ ] **Step 1: Add failing authoring and parser tests**

Cover constant connection metadata, shorthand and structured requirements, invalid dynamic values, parsed graph metadata, and generated deployment artifacts.

- [ ] **Step 2: Add failing runtime transition tests**

Require a distinct `connection_call` transition with alias, action, arguments, and stable invocation identity. An undeclared alias must fail before provider invocation.

- [ ] **Step 3: Add workflow connection metadata**

Extend the object returned by `defineWorkflow` with optional `connections`. Keep TypeScript code as source of truth and permit only parser-readable constant metadata.

- [ ] **Step 4: Add the caller-bound connection namespace**

Expose `context.connections` from every boundary. It creates durable transitions only; it never contains a credential or concrete connection id.

- [ ] **Step 5: Execute calls through the broker**

Handle `connection_call` beside `host_call`. Attach the run's caller and allocation server-side, audit the decision, and feed the result to the next durable continuation. On auth expiry, pause with a typed action-required record and resume the same boundary after authorization.

- [ ] **Step 6: Update seeded workflow guidance and run tests**

```bash
bunx vitest run packages/workflow/src/__tests__/workflow.test.ts packages/runtime/src/__tests__/context-calls.test.ts packages/parser/src/__tests__/project-parser.test.ts packages/core/src/__tests__/connection-calls.integration.test.ts --config vitest.config.ts
```

### Task 7: Issue short-lived capability grants and serve brokered MCP gateways

**Files:**
- Create: `packages/core/src/services/connection-capability-grants.ts`
- Create: `packages/fastify-plugin/src/routes/connection-mcp.ts`
- Modify: `packages/fastify-plugin/src/plugin.ts`
- Modify: `packages/fastify-plugin/src/schemas.ts`
- Modify: `packages/core/src/services/agent-sessions-service.ts`
- Modify: `packages/ai-sdk/src/ai-sdk-agent.ts`
- Modify: `packages/claude-code/src/claude-code-agent.ts`
- Modify: `packages/codex/src/codex-agent.ts`
- Modify: `apps/desktop/src/main/server/agent-registry.ts`
- Test: `packages/core/src/__tests__/connection-capability-grants.integration.test.ts`
- Test: `packages/fastify-plugin/src/__tests__/connection-mcp.integration.test.ts`
- Test: `packages/ai-sdk/src/__tests__/ai-sdk-agent.test.ts`
- Test: `packages/claude-code/src/__tests__/claude-code-agent.test.ts`
- Test: `packages/codex/src/__tests__/codex-agent.test.ts`

**Interfaces:**
- Produces: allocation-bound bearer grants and per-binding MCP gateway routes.
- Consumes: agent session Allocation, connection broker, and ADR 0054 tool policy.

- [ ] **Step 1: Add failing grant tests**

Cover random token creation, hash-only persistence, Allocation and session binding, expiry, rotation, explicit revocation, connection-revocation cascade, and no cross-tenant/session/binding use.

- [ ] **Step 2: Add failing MCP gateway tests**

Cover initialize, tools/list, tools/call, provider annotations, namespacing, caller and role scope, ask/allow/deny, revoked grants, expired auth, sanitized errors, and absence of provider headers in harness config.

- [ ] **Step 3: Implement grant issuance and validation**

Issue only after successful admission and Allocation creation. Return the clear token once to the trusted harness setup path. Store the SHA-256 hash. Revoke when sessions/allocations/connections end.

- [ ] **Step 4: Serve one gateway per logical binding**

Add a route below the project and session that validates the capability token independently of the host's member bearer. Forward list/call through the broker and preserve MCP annotations.

- [ ] **Step 5: Route all harnesses through the gateway**

Generate token-bearing Catamorphic gateway configs for ai-sdk, Claude Code, and Codex. Do not pass upstream URLs, headers, env, OAuth state, or service credentials to a harness. Apply live policy in the gateway; Codex spawn-time filtering remains an additional narrowing layer.

- [ ] **Step 6: Run focused tests**

```bash
bunx vitest run packages/core/src/__tests__/connection-capability-grants.integration.test.ts packages/fastify-plugin/src/__tests__/connection-mcp.integration.test.ts packages/ai-sdk/src/__tests__/ai-sdk-agent.test.ts packages/claude-code/src/__tests__/claude-code-agent.test.ts packages/codex/src/__tests__/codex-agent.test.ts --config vitest.config.ts
```

### Task 8: Add connection and authorization APIs with structured 428 responses

**Files:**
- Create: `packages/fastify-plugin/src/routes/connections.ts`
- Modify: `packages/fastify-plugin/src/plugin.ts`
- Modify: `packages/fastify-plugin/src/schemas.ts`
- Modify: `packages/fastify-plugin/src/error-handler.ts`
- Modify: `packages/server-sdk/src/catamorphic.ts`
- Modify: `packages/api-client/src/generated/openapi.ts`
- Test: `packages/fastify-plugin/src/__tests__/connections.integration.test.ts`
- Test: `packages/fastify-plugin/src/__tests__/agent-sessions.integration.test.ts`
- Test: `packages/fastify-plugin/src/__tests__/runs.integration.test.ts`

**Interfaces:**
- Produces: discovery, self-authorization, service management, binding management, callback, revoke, audit, and `authentication_required` APIs.
- Consumes: connection services, admission, and providers.

- [ ] **Step 1: Add failing route tests**

Cover tenant isolation, self vs service administration, Environment access, secret-field write-only behavior, one-time OAuth state, callback actor binding, safe public records, service revocation, and exact 428 session/run payloads with no created Allocation.

- [ ] **Step 2: Implement Zod-first routes**

Add prefix-relative routes for:

- listing bindings and connection status per project Environment;
- beginning/completing member authorization;
- attaching and detaching a member connection;
- managing service connections and binding assignments;
- revoking connections;
- listing sanitized audit events.

Authorization begin returns a typed challenge. Sensitive form values are accepted only on writes and never echoed.

- [ ] **Step 3: Map admission failures to HTTP 428**

Return `code: "authentication_required"`, Environment, requirements, provider display information, and an authorization-start URL or action. Do not include connection ids the caller cannot administer or any provider material.

- [ ] **Step 4: Generate API artifacts**

```bash
cd packages/fastify-plugin && bun run generate-spec
cd ../api-client && bun run generate
cd ../..
```

- [ ] **Step 5: Run route tests**

```bash
bunx vitest run packages/fastify-plugin/src/__tests__/connections.integration.test.ts packages/fastify-plugin/src/__tests__/agent-sessions.integration.test.ts packages/fastify-plugin/src/__tests__/runs.integration.test.ts --config vitest.config.ts
```

### Task 9: Implement encrypted vaults and provider wiring in both reference hosts

**Files:**
- Create: `apps/desktop/src/main/credential-vault.ts`
- Modify: `apps/desktop/src/main/connections-store.ts`
- Modify: `apps/desktop/src/main/connectors.ts`
- Modify: `apps/desktop/src/main/server/boot.ts`
- Create: `apps/server/src/credential-vault.ts`
- Modify: `apps/server/src/config.ts`
- Modify: `apps/server/src/main.ts`
- Modify: `apps/server/src/server.ts`
- Test: `apps/desktop/src/main/__tests__/credential-vault.test.ts`
- Test: `apps/server/src/__tests__/credential-vault.test.ts`
- Test: `apps/server/src/__tests__/server.test.ts`

**Interfaces:**
- Produces: Electron safeStorage vault, stock-server AES-256-GCM file vault, and remote MCP provider registration.
- Consumes: framework vault/provider contracts.

- [ ] **Step 1: Add failing vault tests**

Desktop tests prove persisted values are encrypted and renderer-facing records are value-free. Server tests prove key and ciphertext files are mode 0600, nonces are unique, tampering fails closed, plaintext never appears on disk, and rotation replaces rather than duplicates material.

- [ ] **Step 2: Refactor desktop connection storage**

Move secret maps and OAuth state behind the injected vault while retaining profile-level connector UX. Migrate the current greenfield `connections.json` format in place, deleting plaintext fallback fields after successful vault write.

- [ ] **Step 3: Implement the stock-server encrypted file vault**

Generate a key on first boot under the configured data directory. Use authenticated encryption, atomic file replacement, explicit permissions, and a versioned ciphertext envelope. Never derive the vault key from a member bearer token.

- [ ] **Step 4: Register remote MCP provider in both hosts**

Desktop uses the existing loopback browser callback. Stock server uses its public base URL and Fastify callback. Hosts supply OAuth client hints through deployment configuration when an MCP server does not support dynamic registration.

- [ ] **Step 5: Run host tests**

```bash
bunx vitest run apps/desktop/src/main/__tests__/credential-vault.test.ts apps/server/src/__tests__/credential-vault.test.ts apps/server/src/__tests__/server.test.ts --config vitest.config.ts
```

### Task 10: Add Environment connection UI and auth-required retry

**Files:**
- Modify: `apps/desktop/DESIGN.md`
- Modify: `apps/desktop/src/renderer/lib/desktop-api.ts`
- Modify: `apps/desktop/src/main/ipc.ts`
- Modify: `apps/desktop/src/main/preload.ts`
- Modify: `apps/desktop/src/renderer/components/connectors-modal.tsx`
- Create: `apps/desktop/src/renderer/components/environment-connections.tsx`
- Create: `apps/desktop/src/renderer/components/authentication-required-card.tsx`
- Modify: `apps/desktop/src/renderer/components/chat-dock.tsx`
- Modify: `apps/desktop/src/renderer/components/run-panel.tsx`
- Modify: `packages/react/src/hooks/index.ts`
- Create: `packages/react/src/hooks/use-environment-connections.ts`
- Create: `packages/react/src/hooks/use-authorize-connection.ts`
- Test: `apps/desktop/src/renderer/components/__tests__/environment-connections.test.tsx`
- Test: `apps/desktop/e2e/environment-connections.e2e.ts`

**Interfaces:**
- Produces: status and management UI per Environment, service-principal labels, auth prompt, callback completion, and automatic retry of session/run creation.
- Consumes: Environment picker and connection APIs.

- [ ] **Step 1: Add failing component tests**

Cover ready/missing/expired/revoked states, personal vs service labels, insufficient role messaging, provider scopes, service bindings that cannot run in the selected Environment, and secret values never entering renderer state.

- [ ] **Step 2: Add failing Electron e2e flow**

Use an e2e fake connection provider. Start an agent requiring a missing member connection, assert no session/allocation starts, complete fake URL authorization, retry, call a brokered fake MCP tool, revoke, and assert the next call requests authorization.

- [ ] **Step 3: Implement Environment-scoped connection management**

Evolve Connectors into a view that makes Environment and principal ownership explicit. Members can authorize their own bindings. Authorized administrators can assign or revoke service bindings without exposing write-only material after save.

- [ ] **Step 4: Implement 428 handling and retry**

Chat and run launch catch `authentication_required`, render a card, open the provider challenge, observe completion, and retry the exact original request once. Closing or denying the flow leaves no partial workload.

- [ ] **Step 5: Record the desktop design decision and run UI tests**

Document Environment-scoped connections, service identity labels, and auth-required retry in the design log.

```bash
bunx vitest run apps/desktop/src/renderer/components/__tests__/environment-connections.test.tsx --config vitest.config.ts
cd apps/desktop && bun run test:e2e -- environment-connections.e2e.ts
```

### Task 11: Add durable auth-expiry recovery, rotation, revocation, and audit telemetry

**Files:**
- Modify: `packages/core/src/services/connection-broker.ts`
- Modify: `packages/core/src/services/connections-service.ts`
- Modify: `packages/core/src/services/runs-service.ts`
- Modify: `packages/core/src/services/agent-sessions-service.ts`
- Modify: `packages/core/src/services/allocations-service.ts`
- Modify: `packages/core/src/services/connection-capability-grants.ts`
- Modify: `packages/core/src/core.ts`
- Modify: `packages/otel/src/index.ts`
- Test: `packages/core/src/__tests__/connection-recovery.integration.test.ts`

**Interfaces:**
- Produces: action-required pause/resume, optimistic refresh, cascade revocation, and `catamorphic.connection.*` spans.
- Consumes: run pause machinery, grants, vault, providers, and audit events.

- [ ] **Step 1: Write failing recovery tests**

Cover expiry during a workflow call, typed pause, reauthorization and resume from the same durable boundary, refresh race, provider revoke failure with local fail-closed behavior, session grant invalidation, and historical audit retention.

- [ ] **Step 2: Implement auth action-required state**

Persist only connection and requirement identifiers plus sanitized status. Never persist provider errors or secrets. Wake the parked workflow after the relevant connection revision becomes ready.

- [ ] **Step 3: Implement optimistic refresh and fail-closed revoke**

Use connection revision compare-and-swap. Revoke grants before attempting provider revocation. Delete vault material even if the provider revoke endpoint fails, while retaining a sanitized audit error.

- [ ] **Step 4: Add telemetry**

Instrument admission, authorization, refresh, broker calls, and revocation. Attribute names use `catamorphic.connection.*`; exclude provider scopes when they could contain tenant-sensitive values and exclude all arguments/results.

- [ ] **Step 5: Run recovery tests**

```bash
bunx vitest run packages/core/src/__tests__/connection-recovery.integration.test.ts --config vitest.config.ts
```

### Task 12: Document deployment requirements and complete verification

**Files:**
- Modify: `INTEGRATION.md`
- Modify: `packages/plugins/README.md`
- Modify: `apps/server/README.md`
- Modify: `docs/decisions/README.md`
- Modify: `docs/superpowers/plans/2026-08-23-credential-connections.md`

- [ ] **Step 1: Document the operator contract**

Explain vault injection, backup and rotation, public OAuth callback URLs, TLS, proxy headers, dynamic registration vs pre-registered OAuth clients, Slack app setup, Google Cloud and Workspace admin setup, member vs service principals, Environment binding policy, and why connector registries do not eliminate provider registration.

- [ ] **Step 2: Document extension seams**

Show a sanitized `ConnectionProvider` example and how a plugin registers it. State that provider credentials are unavailable to workflow and app code and that host-side broker actions are the extension point.

- [ ] **Step 3: Run migration and generated-artifact checks**

```bash
bun run db:migrate
bun run db:codegen
cd packages/fastify-plugin && bun run generate-spec
cd ../api-client && bun run generate
cd ../..
```

- [ ] **Step 4: Run repository verification**

```bash
bun run lint
bun run typecheck
bun run build
bun run test
```

- [ ] **Step 5: Run the desktop checklist**

```bash
cd apps/desktop
bun run typecheck
bun run test
bun run test:e2e
bun run test:e2e:visible
```

- [ ] **Step 6: Review security invariants**

Search the diff and built artifacts for fixture tokens, `credentialRef` exposure, raw headers, OAuth state, service-account keys, and accidental `project_secrets` use. Confirm every secret-bearing code path remains in a host vault/provider and every sandbox-facing value is a capability grant.

- [ ] **Step 7: Review and fix the complete diff**

Run `git diff --check`, inspect every changed file, rerun affected focused tests after fixes, then rerun the full verification commands whose inputs changed. Update this plan's checkboxes and record any intentional deferrals in the design spec rather than silently omitting them.

- [ ] **Step 8: Prepare manual testing guidance**

Provide a short local checklist for Environment selection, missing member auth, fake or real MCP OAuth, service binding restrictions, workflow connection calls, agent MCP tools, revocation, and audit inspection. Do not claim real Slack or Google Workspace authorization works without deployment-owned provider app configuration.
