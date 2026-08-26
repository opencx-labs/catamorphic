# Capability Gateway and Allocation Runners Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every harness and remote Environment one policy-enforced capability surface and make Allocation runners own workspace, process, and remote routing.

**Architecture:** Capability definitions are dependency-light contracts in `@catamorphic/sandbox`; core owns registration, invocation, policy, approval, audit, and placement. Transport adapters expose the same registry in-process, over MCP, and as Codex dynamic tools. Environment bindings supply a runner; public placement becomes only `control_plane | environment`.

**Tech Stack:** TypeScript, Zod/JSON Schema, MCP, Fastify, OpenTelemetry, Bun subprocesses, Microsandbox, Cloudflare Sandbox, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-24-agent-runtime-capabilities-and-personal-artifacts-design.md`

## Global Constraints

- MCP is a transport, not the internal authorization or lifecycle model.
- One invocation pipeline performs validation, live authorization, policy, approval, execution, output sanitization, audit, and tracing.
- Capabilities never return provider credentials.
- Allocation runner selection is immutable for the Allocation lifetime.
- Delete `ExtraTool`, `ExtraToolContext`, `workspace-mcp`, and four-topology branches after cutover.
- Do not stage or commit without explicit user approval.

---

### Task 1: Define capability contracts and registry behavior

**Files:**
- Create: `packages/sandbox/src/capabilities/types.ts`
- Create: `packages/sandbox/src/capabilities/registry.ts`
- Create: `packages/sandbox/src/capabilities/__tests__/registry.test.ts`
- Create: `packages/sandbox/src/capabilities/index.ts`
- Modify: `packages/sandbox/src/index.ts`

**Interfaces:**
- Produces: `CapabilityDefinition`, `CapabilityAnnotations`, `CapabilityInvocation`, `CapabilityResult`, `CapabilityProgress`, `CapabilityRegistry`.

- [ ] **Step 1: Write failing duplicate, schema, and replacement tests**

```ts
const registry = new CapabilityRegistry();
registry.register({ definition, invoke });
expect(() => registry.register({ definition, invoke })).toThrow("Duplicate capability 'process.start'");
expect(registry.replace({ definition, invoke }).definition.id).toBe("process.start");
```

Also require namespace/name validation and immutable definition snapshots.

- [ ] **Step 2: Run the test and confirm missing modules**

Run `bunx vitest run packages/sandbox/src/capabilities/__tests__/registry.test.ts --config vitest.config.ts`.

- [ ] **Step 3: Implement contracts and registry**

Use JSON Schema values rather than importing Zod into sandbox contracts. Define invocation context with identity scope reference, project, Allocation, session/turn, enablement, connection grants, request id, deadline, cancellation signal, and trace carrier.

- [ ] **Step 4: Pass focused tests and inspect package dependencies**

Expected: PASS and `packages/sandbox/package.json` gains no schema or server dependency.

### Task 2: Implement the core gateway, policy, approvals, and audit

**Files:**
- Create: `packages/core/src/services/capability-gateway.ts`
- Create: `packages/core/src/services/capability-policy.ts`
- Create: `packages/core/src/services/capability-audit.ts`
- Create: `packages/core/src/__tests__/capability-gateway.test.ts`
- Modify: `packages/core/src/services/tool-permission-broker.ts`
- Modify: `packages/core/src/core.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `CapabilityRegistry`, runtime requests, Identity, Allocation, connection broker.
- Produces: `CapabilityGateway.invoke/describe/list` and one policy resolution path for host and connection tools.

- [ ] **Step 1: Write failing policy-pipeline tests**

Assert read-only `auto` invokes immediately, destructive `auto` creates an approval, deny never calls the implementation, expired deadlines cancel, output schema failures are sanitized, and revoked connection scope fails on the next call.

- [ ] **Step 2: Run focused tests and confirm no gateway exists**

Run `bunx vitest run packages/core/src/__tests__/capability-gateway.test.ts --config vitest.config.ts`.

- [ ] **Step 3: Implement invocation in the required order**

The implementation must call `resolve -> validateInput -> revalidateAuthority -> resolvePolicy -> approve -> route -> validateOutput -> audit`. Emit progress through an injected sink and create approval requests through `AgentRuntimeRequestsService`.

- [ ] **Step 4: Instrument and pass tests**

Add `capability.invoke` spans with capability id, project id, Allocation id, outcome, and timing. Never attach arguments/results. Run focused tests and require PASS.

### Task 3: Expose one registry through in-process, MCP, and Codex adapters

**Files:**
- Create: `packages/ai-sdk/src/capability-tools.ts`
- Create: `packages/claude-code/src/capability-mcp.ts`
- Create: `packages/codex/src/capability-tools.ts`
- Create: `packages/fastify-plugin/src/routes/capabilities-mcp.ts`
- Create: `packages/fastify-plugin/src/__tests__/capabilities-mcp.integration.test.ts`
- Modify: `packages/fastify-plugin/src/plugin.ts`
- Modify: `packages/ai-sdk/src/ai-sdk-agent.ts`
- Modify: `packages/claude-code/src/claude-code-agent.ts`
- Modify: `packages/codex/src/codex-agent.ts`
- Delete: `apps/desktop/src/main/server/workspace-mcp.ts`
- Delete: `apps/desktop/src/main/server/workspace-mcp.test.ts`

**Interfaces:**
- Consumes: `CapabilityGateway` and provider runtime adapters.
- Produces: identical definition/result behavior across all three transports.

- [ ] **Step 1: Write a transport parity integration test**

Register `test.echo`, invoke it directly, through MCP, and through the Codex dynamic-tool fixture, then require equal structured content and identical audit capability ids.

- [ ] **Step 2: Run the parity test and confirm transport divergence**

Run the new Fastify integration test. Expected: FAIL because no shared MCP endpoint exists.

- [ ] **Step 3: Implement thin adapters**

Adapters translate definitions and content only. They may not contain policy or business invocation logic. Bind HTTP MCP grants to Allocation and identity; reject expired or mismatched grants before gateway invocation.

- [ ] **Step 4: Replace desktop workspace tool registration**

Make `apps/desktop/src/main/server/workspace-tools.ts` return capability registrations. Remove `ExtraTool` construction and Claude/Codex special cases from `agent-registry.ts`.

- [ ] **Step 5: Pass parity and provider conformance tests**

Run Fastify, AI SDK, Claude, Codex, and desktop workspace-tool tests. Expected: the same tool id and structured result appear in each adapter.

### Task 4: Define Allocation runner contracts and local runner

**Files:**
- Create: `packages/sandbox/src/runner/types.ts`
- Create: `packages/sandbox/src/runner/index.ts`
- Create: `packages/sandbox/src/runner/__tests__/runner-contract.test.ts`
- Modify: `packages/sandbox/src/execution-environment.ts`
- Create: `packages/local-process/src/local-allocation-runner.ts`
- Create: `packages/local-process/src/__tests__/local-allocation-runner.test.ts`
- Modify: `packages/local-process/src/index.ts`
- Modify: `packages/core/src/services/execution-environments-service.ts`
- Modify: `packages/core/src/services/execution-allocations-service.ts`

**Interfaces:**
- Consumes: `AgentLoopPlacement = "control_plane" | "environment"` from the runtime foundation.
- Produces: `AllocationRunner`, `AllocationWorkspace`, `RunnerEvent`, `RunnerEventCursor`.
- Produces: `LocalAllocationRunner` used by desktop and stock server.

- [ ] **Step 1: Write runner contract tests**

Require exact-revision workspace attachment, cursor-based events, idempotent release, health reporting, and rejection of an operation for the wrong Allocation id.

- [ ] **Step 2: Run focused tests and confirm missing runner types**

Run both runner test files.

- [ ] **Step 3: Implement dependency-light runner contracts**

`EnvironmentRuntimeBinding` supplies `runner: AllocationRunner`; public descriptors expose only capabilities and placement support. Credentials and host paths remain absent from public shapes.

- [ ] **Step 4: Implement local runner**

Use explicit cwd and environment for Bun subprocesses. Resolve project paths through the host callback, validate they belong to the allocated project, emit monotonic runner events, and release only resources owned by the Allocation.

- [ ] **Step 5: Pass runner and allocation tests**

Run local-process, sandbox, and core Environment/Allocation suites. Expected: one local runner supports both placements without public native/contained labels.

### Task 5: Add remote runner transport and delete topology compatibility

**Files:**
- Create: `packages/cloudflare/src/cloudflare-allocation-runner.ts`
- Create: `packages/cloudflare/src/__tests__/cloudflare-allocation-runner.test.ts`
- Modify: `packages/cloudflare-sandbox-bridge/src/index.ts`
- Modify: `packages/microsandbox/src/index.ts`
- Modify: `packages/microsandbox/src/sandbox-provider.ts`
- Modify: `packages/microsandbox/src/stdio-runtime-provider.ts`
- Modify: `packages/daytona/src/index.ts`
- Modify: `packages/daytona/src/sandbox-provider.ts`
- Modify: `packages/core/src/services/coding-agent-registry.ts`
- Modify: `packages/core/src/services/agent-sessions-service.ts`
- Modify: `apps/desktop/src/main/server/boot.ts`
- Modify: `apps/server/src/server.ts`
- Delete: `apps/desktop/src/main/server/workspace-tools.ts` after registrations move to focused capability modules
- Delete: `apps/desktop/src/main/server/workspace-tools.test.ts` after replacement tests exist

**Interfaces:**
- Consumes: `AllocationRunner` and capability gateway routing.
- Produces: remote runner request/event protocol with lease id and event cursor.

- [ ] **Step 1: Write remote reconnect and fencing tests**

Simulate a lost HTTP stream, resume after cursor 4, reject an old lease's command, and ensure duplicate runner event ids reduce once.

- [ ] **Step 2: Run focused Cloudflare tests and confirm no runner transport**

Run the new Cloudflare runner suite.

- [ ] **Step 3: Implement bridge endpoints and client**

Add authenticated allocate, workspace, runtime-command, capability-invoke, process-command, events, health, and release endpoints. Every mutation includes Allocation id and lease fence. Return only sanitized runner events.

- [ ] **Step 4: Adapt providers and host boots**

Microsandbox and Daytona implement the same runner seam. Desktop injects `LocalAllocationRunner`; stock server does the same. Cloudflare bindings inject `CloudflareAllocationRunner`.

- [ ] **Step 5: Hard-delete old topology names and tool bridges**

Run `rg 'controller|contained|native|external|ExtraTool|ExtraToolContext|workspaceMcp' packages apps`. Retain ordinary prose uses only; runtime APIs must use `control_plane | environment` and capabilities.

- [ ] **Step 6: Verify the sub-plan**

Run lint, typecheck, build, tests, API generation, bridge tests, and `git diff --check`. Stop at a reviewable working-tree checkpoint.
