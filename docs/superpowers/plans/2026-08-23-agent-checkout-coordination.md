# Agent Checkout Coordination Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every desktop harness project-scoped peer awareness and an agent-controlled choice between a shared primary checkout, waiting, and an optional managed or external Git worktree.

**Architecture:** Core owns authorized session summaries, runtime running state, activity text, session-aware host path resolution, and whole-checkout checkpoint serialization hooks. The desktop owns local checkout paths and system-Git worktree lifecycle through a focused `SessionCheckoutsStore`; its harness-neutral workspace tools expose coordination to the built-in agent and Claude directly and to Codex through a loopback MCP route. Agent definitions carry only the role doctrine enum.

**Tech Stack:** TypeScript, Kysely/Postgres and PGlite migrations, Fastify/Zod/OpenAPI, Electron, system Git, MCP, Vitest, Playwright-style desktop E2E.

**Spec:** `docs/superpowers/specs/2026-08-23-agent-checkout-coordination-design.md`

## Global Constraints

- New sessions remain in the primary project folder until the agent explicitly creates or adopts a worktree.
- Shared sessions share files, Git state, whole-checkout checkpoints, commits, and rollback; do not implement file claims or per-agent attribution.
- Peer visibility defaults to the current project and excludes incognito sessions in the desktop host.
- Filesystem paths remain host-local and never enter mirrored Catamorphic session rows.
- Catamorphic is the sole owner of top-level checkout selection; Claude Code `EnterWorktree` and `ExitWorktree` remain unavailable.
- Worktree behavior must be identical across Claude Code and Codex even though Codex consumes the tools through MCP.
- User-facing copy contains no em dashes or en dashes.
- External worktrees are never automatically removed.

---

### Task 1: Core session coordination surface

**Files:**
- Create: `packages/db/migrations/063_agent_session_activity.sql`
- Modify: `packages/db/src/generated/db.ts`
- Modify: `packages/core/src/services/agent-sessions-service.ts`
- Modify: `packages/core/src/core.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/__tests__/agent-session-coordination.integration.test.ts`

**Interfaces:**
- Produces: `AgentCoordinationStrategy`, `AgentSessionPeer`, `AgentSession.activity`, `AgentSession.running`, `AgentSessionsService.listPeers(...)`, and `AgentSessionsService.setActivity(...)`.
- Produces: session-aware `hostAgentCheckout.resolve({ projectId, sessionId })` and optional `hostAgentCheckout.checkpoint(...)` callbacks in `CatamorphicCoreConfig`.
- Consumes later: desktop session-context reader, checkout resolver, and checkpoint implementation.

- [ ] **Step 1: Write the failing coordination integration tests**

Create tests that start two sessions in one project and a third in another, mark one running with a deferred fake provider, and assert:

```ts
const peers = await sessions.listPeers(identity, project.id, first.id);
expect(peers).toEqual([
  expect.objectContaining({
    id: second.id,
    running: true,
    task: "Prepare the Globex renewal deck",
    activity: "Editing presentations/globex-renewal.pptx",
  }),
]);
expect(peers.some((peer) => peer.projectId === otherProject.id)).toBe(false);
```

Cover builder visibility, scoped-agent narrowing, transcript caps, clearing activity, and omission of the current session.

- [ ] **Step 2: Run the test and verify it fails**

Run: `bunx vitest run packages/core/src/__tests__/agent-session-coordination.integration.test.ts --config vitest.config.ts`

Expected: failure because the migration, `listPeers`, and `setActivity` do not exist.

- [ ] **Step 3: Add the activity migration and generated type**

Add one nullable bounded text column:

```sql
ALTER TABLE agent_sessions
  ADD COLUMN activity varchar(500);
```

Do not store checkout paths or coordination strategy in the shared schema.

- [ ] **Step 4: Implement authorized peer summaries**

Add:

```ts
export interface AgentSessionPeer {
  id: string;
  projectId: string;
  title: string | null;
  agentId: string | null;
  running: boolean;
  task: string | null;
  activity: string | null;
  updatedAt: string;
}

async listPeers(
  identity: Identity,
  projectId: string,
  ownSessionId: string,
): Promise<AgentSessionPeer[]>;

async setActivity(
  identity: Identity,
  projectId: string,
  sessionId: string,
  activity: string | null,
): Promise<void>;
```

Reuse the existing builder/scope filters. Derive `task` from the latest user
message, normalize whitespace, and cap it at 240 characters. Overlay
`runningTurns.has(id)` at read time instead of persisting volatile state.

- [ ] **Step 5: Add session-aware host checkout callbacks**

Replace the project-only resolver with:

```ts
export interface HostAgentCheckout {
  resolve(input: {
    projectId: string;
    sessionId: string;
  }): Promise<string | undefined> | string | undefined;
  checkpoint?(input: {
    projectId: string;
    sessionId: string;
    workingDirectory: string;
    message: string;
  }): Promise<string | null>;
}
```

Host agents resolve on every turn. Their checkpoint uses the host callback;
sandbox agents retain `ProjectManager` behavior. Pass the resolved directory
through `AgentTurnSettledEvent` so the desktop can avoid syncing main for an
isolated turn.

- [ ] **Step 6: Run focused core tests**

Run: `bunx vitest run packages/core/src/__tests__/agent-session-coordination.integration.test.ts packages/core/src/__tests__/agent-store-sync.integration.test.ts --config vitest.config.ts`

Expected: all tests pass.

- [ ] **Step 7: Commit the core coordination slice**

```bash
git add packages/db/migrations/063_agent_session_activity.sql packages/db/src/generated/db.ts packages/core/src/services/agent-sessions-service.ts packages/core/src/core.ts packages/core/src/index.ts packages/core/src/__tests__/agent-session-coordination.integration.test.ts
git commit -m "feat(core): expose project session coordination"
```

### Task 2: Role coordination doctrine

**Files:**
- Modify: `packages/core/src/services/agent-definitions-service.ts`
- Modify: `packages/core/src/__tests__/agent-definitions.integration.test.ts`
- Modify: `apps/desktop/src/main/agents-store.ts`
- Modify: `apps/desktop/src/main/agents-store.test.ts`
- Modify: `apps/desktop/src/main/server/agent-registry.ts`
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `apps/desktop/src/renderer/lib/desktop-api.ts`
- Modify: `apps/desktop/src/renderer/components/configure-agent-modal.tsx`

**Interfaces:**
- Produces: `AgentCoordinationStrategy = "shared-first" | "isolate-on-contention" | "isolation-required"` on profile and project agents.
- Consumes later: `WorkspaceContextAgent` prompt rendering.

- [ ] **Step 1: Write failing store and definition tests**

Assert absent values materialize as `shared-first`, all three values round
trip, invalid project definitions fail validation, and the field participates
in provider cache invalidation but not credential consent hashing.

- [ ] **Step 2: Run the tests and verify they fail**

Run: `bunx vitest run apps/desktop/src/main/agents-store.test.ts packages/core/src/__tests__/agent-definitions.integration.test.ts --config vitest.config.ts`

Expected: failures for the missing property and schema.

- [ ] **Step 3: Add the shared enum and persistence**

Use this exact public shape:

```ts
export type AgentCoordinationStrategy =
  | "shared-first"
  | "isolate-on-contention"
  | "isolation-required";
```

Add optional `coordination` to committed definitions and stored profile
agents. Materialize `shared-first` in renderer-facing objects.

- [ ] **Step 4: Expose the setting in the configure-agent surface**

Add one labeled select under Capabilities with plain descriptions:

- “Share the project folder” (`shared-first`)
- “Prefer a worktree when others are active” (`isolate-on-contention`)
- “Always isolate concurrent editing” (`isolation-required`)

Do not introduce a global worktree mode or workspace picker.

- [ ] **Step 5: Run store, definition, and renderer type tests**

Run: `bunx vitest run apps/desktop/src/main/agents-store.test.ts packages/core/src/__tests__/agent-definitions.integration.test.ts --config vitest.config.ts`

Run: `bun run typecheck` from `apps/desktop`.

Expected: all pass.

- [ ] **Step 6: Commit role doctrine**

```bash
git add packages/core/src/services/agent-definitions-service.ts packages/core/src/__tests__/agent-definitions.integration.test.ts apps/desktop/src/main/agents-store.ts apps/desktop/src/main/agents-store.test.ts apps/desktop/src/main/server/agent-registry.ts apps/desktop/src/preload/index.ts apps/desktop/src/renderer/lib/desktop-api.ts apps/desktop/src/renderer/components/configure-agent-modal.tsx
git commit -m "feat(desktop): configure agent coordination strategy"
```

### Task 3: Desktop checkout manager

**Files:**
- Create: `apps/desktop/src/main/server/session-checkouts.ts`
- Create: `apps/desktop/src/main/server/session-checkouts.test.ts`
- Modify: `apps/desktop/src/main/server/paths.ts`
- Modify: `apps/desktop/src/main/server/boot.ts`
- Modify: `apps/desktop/src/main/git-view.ts`

**Interfaces:**
- Produces: `SessionCheckouts` with `resolve`, `list`, `createManaged`, `adopt`, `returnPrimary`, `describe`, and `checkpoint`.
- Consumes: project root lookup and a configurable worktree root.

- [ ] **Step 1: Write temporary-repository tests**

Cover:

```ts
const created = await checkouts.createManaged({ projectId, sessionId });
expect(created.kind).toBe("managed");
expect(created.branch).toMatch(/^catamorphic\//);
expect(await checkouts.resolve({ projectId, sessionId })).toBe(created.path);
```

Also test porcelain `-z` parsing, external adoption, rejection of a different
common Git directory, stale-binding fallback, branch collision retry, and
that `returnPrimary` never removes the worktree.

- [ ] **Step 2: Run the tests and verify they fail**

Run: `bunx vitest run src/main/server/session-checkouts.test.ts --config vitest.config.ts` from `apps/desktop`.

Expected: failure because the manager does not exist.

- [ ] **Step 3: Implement local persistence and system-Git lifecycle**

Store bindings in desktop-local PGlite state, keyed by session id:

```ts
interface SessionCheckoutBinding {
  sessionId: string;
  projectId: string;
  path: string;
  kind: "managed" | "external";
  branch: string | null;
}
```

Create managed worktrees under
`<project>/.catamorphic/worktrees/<session-id>`, add that directory to the
primary repo's local `.git/info/exclude`, and use branch
`catamorphic/<session-id-prefix>` with a numeric collision suffix. Validate
canonical common Git directories for every adoption and resolution.

- [ ] **Step 4: Implement serialized whole-checkout checkpoints**

Use a per-common-directory promise mutex. Inside it run status again, then:

```bash
git add -A
git -c user.name="Catamorphic Agent" \
    -c user.email="agent@catamorphic.dev" \
    commit -m "<checkpoint subject>"
git rev-parse HEAD
```

An already-clean tree returns `null`. Never attribute paths to sessions.

- [ ] **Step 5: Wire the session-aware resolver and checkpoint callback**

Pass `hostAgentCheckout: { resolve, checkpoint }` to `createCatamorphic`.
Skip automatic main remote sync when the settled event's directory is not the
primary project root.

- [ ] **Step 6: Run checkout-manager tests**

Run: `bunx vitest run src/main/server/session-checkouts.test.ts --config vitest.config.ts` from `apps/desktop`.

Expected: all pass.

- [ ] **Step 7: Commit the desktop checkout manager**

```bash
git add apps/desktop/src/main/server/session-checkouts.ts apps/desktop/src/main/server/session-checkouts.test.ts apps/desktop/src/main/server/paths.ts apps/desktop/src/main/server/boot.ts apps/desktop/src/main/git-view.ts
git commit -m "feat(desktop): manage session git checkouts"
```

### Task 4: Harness-neutral coordination tools and prompts

**Files:**
- Modify: `apps/desktop/src/main/server/workspace-tools.ts`
- Modify: `apps/desktop/src/main/server/workspace-context-agent.ts`
- Create: `apps/desktop/src/main/server/workspace-context-agent.test.ts`
- Create: `apps/desktop/src/main/server/workspace-tools.test.ts`
- Modify: `apps/desktop/src/main/server/agent-registry.ts`
- Modify: `apps/desktop/src/main/server/boot.ts`

**Interfaces:**
- Produces: late-bound `SessionCoordinationBridge` and `CheckoutBridge` for the toolset.
- Consumes: core peer APIs, desktop incognito store, agent strategy, and `SessionCheckouts`.

- [ ] **Step 1: Write failing prompt and tool tests**

Assert that a later agent sees:

```text
<project_sessions strategy="shared-first">
- "Prepare Acme QBR" (running, primary checkout)
  Task: Prepare the Acme quarterly presentation
</project_sessions>
```

Assert no block for zero visible peers; incognito peers are filtered; transcript
reads cap messages and characters; activity updates persist; sandbox agents
receive peer tools but not worktree mutations.

- [ ] **Step 2: Run the tests and verify they fail**

Run: `bunx vitest run src/main/server/workspace-context-agent.test.ts src/main/server/workspace-tools.test.ts --config vitest.config.ts` from `apps/desktop`.

Expected: missing bridge methods and tools.

- [ ] **Step 3: Add peer context to every turn**

Extend `WorkspaceContextAgent` with lazy callbacks for strategy and peer
summaries. Add the approved doctrine:

```text
If your task needs edits, inspect concurrent work before changing files.
You may share the primary checkout when the work will not interfere. Sharing
also shares commits and rollback. Use a worktree when isolation is safer, or
wait when your work depends on another session.
```

For `isolation-required`, state that sharing with another active editor is not
allowed.

- [ ] **Step 4: Add the coordination and worktree tools**

Implement the exact tool names from the spec. `create_worktree` and
`use_worktree` return the absolute path plus an instruction to use it for all
remaining file and terminal operations in the current turn. Future turns use
the host resolver automatically.

- [ ] **Step 5: Wire privacy and execution-mode filtering**

Boot supplies peer readers through core and filters `incognitoSessions.has`.
The registry filters worktree mutation tools from sandbox agents and all
mutating coordination tools from read-only agents.

- [ ] **Step 6: Run prompt and tool tests**

Run: `bunx vitest run src/main/server/workspace-context-agent.test.ts src/main/server/workspace-tools.test.ts --config vitest.config.ts` from `apps/desktop`.

Expected: all pass.

- [ ] **Step 7: Commit tools and prompts**

```bash
git add apps/desktop/src/main/server/workspace-tools.ts apps/desktop/src/main/server/workspace-context-agent.ts apps/desktop/src/main/server/workspace-context-agent.test.ts apps/desktop/src/main/server/workspace-tools.test.ts apps/desktop/src/main/server/agent-registry.ts apps/desktop/src/main/server/boot.ts
git commit -m "feat(desktop): let agents coordinate project checkouts"
```

### Task 5: Codex session-scoped workspace MCP

**Files:**
- Modify: `packages/codex/src/codex-agent.ts`
- Modify: `packages/codex/src/__tests__/codex-agent.test.ts`
- Create: `apps/desktop/src/main/server/workspace-mcp.ts`
- Create: `apps/desktop/src/main/server/workspace-mcp.test.ts`
- Modify: `apps/desktop/src/main/server/boot.ts`
- Modify: `apps/desktop/src/main/server/agent-registry.ts`
- Modify: `apps/desktop/package.json`
- Modify: `bun.lock`

**Interfaces:**
- Produces: `CodexAgentOpts.mcpServersForSession(context)` matching Claude and AI SDK behavior.
- Produces: loopback Streamable HTTP MCP route bound to project/session identity.

- [ ] **Step 1: Write failing Codex option and route tests**

Assert the Codex CLI config contains both profile MCP servers and a
session-scoped `workspace` server URL on every spawn, and that calls to the
route execute tools with the path-bound `ExtraToolContext`.

- [ ] **Step 2: Run the tests and verify they fail**

Run: `bunx vitest run packages/codex/src/__tests__/codex-agent.test.ts --config vitest.config.ts`

Run: `bunx vitest run src/main/server/workspace-mcp.test.ts --config vitest.config.ts` from `apps/desktop`.

Expected: missing session MCP support and route.

- [ ] **Step 3: Add Codex per-session MCP resolution**

Add the same callback shape used by the other harnesses:

```ts
mcpServersForSession?: (
  context: ExtraToolContext,
) => Record<string, AgentMcpServerConfig>;
```

Merge it after agent-wide servers so the host-owned session server wins name
collisions. Include it in policy filtering.

- [ ] **Step 4: Implement the loopback MCP endpoint**

Use `@modelcontextprotocol/sdk` Streamable HTTP transport with stateless
requests. Bind `projectId` and `sessionId` from the route, validate the session
through core before executing, and expose the same filtered `ExtraTool[]`
definitions used by Claude. The route is loopback-only because the embedded
server itself is loopback-only.

- [ ] **Step 5: Wire Codex to the workspace MCP URL**

Pass a lazy URL callback from the desktop registry. Replace the existing
“context without tools” Codex comment and set `hasTools: true` so its playbook
matches actual capability.

- [ ] **Step 6: Run Codex and MCP tests**

Run both focused commands from Step 2.

Expected: all pass.

- [ ] **Step 7: Commit Codex parity**

```bash
git add packages/codex/src/codex-agent.ts packages/codex/src/__tests__/codex-agent.test.ts apps/desktop/src/main/server/workspace-mcp.ts apps/desktop/src/main/server/workspace-mcp.test.ts apps/desktop/src/main/server/boot.ts apps/desktop/src/main/server/agent-registry.ts apps/desktop/package.json bun.lock
git commit -m "feat(codex): mount session workspace tools"
```

### Task 6: API, UI context, and end-to-end behavior

**Files:**
- Modify: `packages/fastify-plugin/src/schemas.ts`
- Modify: `packages/fastify-plugin/src/routes/agent.ts`
- Modify: `packages/fastify-plugin/src/__tests__/agent-routes.test.ts`
- Regenerate: `packages/fastify-plugin/openapi.json`
- Regenerate: `packages/api-client/src/schema.d.ts`
- Modify: `apps/desktop/src/renderer/components/catamorphic/sessions-list.tsx` only if checkout labels belong in the shared registry source first
- Modify: `packages/registry/src/sessions-list/sessions-list.tsx`
- Modify: `apps/desktop/e2e/agents.e2e.ts`
- Modify: `apps/desktop/src/main/server/e2e-fakes.ts`

**Interfaces:**
- Produces: HTTP peer listing and activity update for non-desktop embedders.
- Produces: visible isolated-checkout label and two-agent E2E coverage.

- [ ] **Step 1: Add failing route and E2E expectations**

Cover `GET /projects/:projectId/agent/sessions/:sessionId/peers` and
`PATCH /projects/:projectId/agent/sessions/:sessionId/activity`, plus a fake
agent prompt that starts one slow turn, starts a second session, reads the
peer, deliberately shares, and a separate prompt that creates a worktree.

- [ ] **Step 2: Run focused failures**

Run: `bunx vitest run packages/fastify-plugin/src/__tests__/agent-routes.test.ts --config vitest.config.ts`

Run: `bun run test:e2e -- --grep "agent coordination"` from `apps/desktop`.

Expected: missing routes and fake behavior.

- [ ] **Step 3: Add schemas, routes, and generated clients**

Add bounded peer/activity schemas, register the routes with existing error
mapping, regenerate OpenAPI and API client types, and keep checkout filesystem
paths out of all shared response schemas.

- [ ] **Step 4: Add minimal visible checkout context**

Primary sessions remain unlabeled. Isolated sessions show the branch or
“Worktree” in the sessions list and chat context where the host-local checkout
store is available. Do not edit installed registry files without first making
the equivalent source change in `packages/registry`.

- [ ] **Step 5: Extend E2E fakes and cover both choices**

The fake must exercise real tools rather than returning canned text. Assert
the second agent can read the first session, sharing leaves both on primary,
and creating a worktree makes the next turn resolve inside it.

- [ ] **Step 6: Run route and E2E tests**

Run both focused commands from Step 2.

Expected: all pass.

- [ ] **Step 7: Commit API and product flow**

```bash
git add packages/fastify-plugin packages/api-client/src/schema.d.ts packages/registry/src/sessions-list/sessions-list.tsx apps/desktop/src/renderer/components/catamorphic/sessions-list.tsx apps/desktop/e2e/agents.e2e.ts apps/desktop/src/main/server/e2e-fakes.ts
git commit -m "feat: surface agent checkout coordination"
```

### Task 7: Documentation, full verification, review, and delivery

**Files:**
- Modify: `apps/desktop/README.md`
- Modify: `packages/core/src/seeds.ts` if the shipped project skill mentions concurrent agents or Git behavior
- Modify: relevant `skills/**/SKILL.md` files discovered during implementation
- Modify: `TODO.md` if it contains superseded worktree gaps

**Interfaces:**
- Consumes: all completed behavior.
- Produces: accurate public guidance and a verified main-branch delivery.

- [ ] **Step 1: Update documentation and skills**

Document project-scoped peer awareness, shared checkout semantics, role
strategies, managed and external worktrees, checkpoint/rollback consequences,
Claude/Codex parity, and the non-automatic default. Remove statements that
say worktrees are only manually created or that all sessions always share one
folder.

- [ ] **Step 2: Regenerate database and API artifacts**

Run:

```bash
bun run db:migrate
bun run db:codegen
cd packages/fastify-plugin && bun run generate-spec
cd packages/api-client && bun run generate
```

- [ ] **Step 3: Run repository verification**

From the repository root:

```bash
bun run lint
bun run typecheck
bun run build
bun run test
```

Expected: zero errors and zero warnings.

- [ ] **Step 4: Run the desktop checklist**

From `apps/desktop`:

```bash
bun run typecheck
bun run test
bun run test:e2e
bun run test:e2e:visible
```

Expected: all pass.

- [ ] **Step 5: Verify the UI visually**

Launch the desktop app, configure each strategy, run two fake or local
sessions in one project, verify peer context and worktree labels, inspect the
console, and capture a screenshot for review. Confirm there are no layout,
focus, or console regressions.

- [ ] **Step 6: Review the complete diff**

Inspect `git diff main^..main` plus uncommitted changes for security,
authorization, lifecycle cleanup, path traversal, destructive Git behavior,
API compatibility, test quality, and documentation consistency. Run focused
tests again for every issue fixed during review.

- [ ] **Step 7: Commit only task-owned files and push main**

Preserve the user's unrelated `context-pill` changes. Stage only files from
this plan, commit any final review fixes, verify `git status`, then:

```bash
git push origin main
```

Expected: `origin/main` points at the verified implementation commit and the
unrelated user changes remain uncommitted in the working tree.
