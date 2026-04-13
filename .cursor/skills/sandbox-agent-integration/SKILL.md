# Sandbox & Agent Integration

## Overview

`@catamorphic/sandbox` provides two core capabilities:

1. **Workflow Execution** — Runs workflow code inside Daytona sandboxes with step-level observability
2. **Coding Agent** — AI-assisted code generation via Codex SDK running inside dev sandboxes

## Two-Sandbox Model

Each project uses two distinct sandbox types:

- **Execution Sandbox** — Pinned to a commit SHA, immutable code, for running workflows. Keyed by `(project_id, commit_sha)`.
- **Dev Sandbox** — Per-user, mutable code, for the coding agent. Keyed by `(project_id, user_id)`.

## Package Structure

```
packages/sandbox/src/
  types.ts              -- SandboxProvider, SandboxManager, RunExecutor, CodingAgent interfaces
  daytona-provider.ts   -- DaytonaSandboxProvider (Daytona SDK wrapper)
  sandbox-manager.ts    -- SandboxManagerImpl (two-sandbox lifecycle)
  run-executor.ts       -- RunExecutorImpl (execute workflows via sandbox)
  coding-agent/
    types.ts            -- CodingAgentProvider interface (extensible)
    codex-agent.ts      -- CodexAgent (Codex SDK implementation)
    index.ts
  index.ts

packages/runtime/src/
  harness.ts            -- Entry point that runs inside sandbox
  step-wrapper.ts       -- Wraps "use step" functions for observability
  reporter.ts           -- Reports run results to Catamorphic API
  types.ts              -- StepEntry, RunReport types
  index.ts

packages/git/src/
  daytona-backend.ts    -- StorageBackend using Daytona dev sandboxes
  daytona-project-repo.ts -- ProjectRepo using Daytona's git/fs APIs
```

## Sandbox Provider Interface

```typescript
import { DaytonaSandboxProvider, SandboxManagerImpl } from "@catamorphic/sandbox";

const provider = new DaytonaSandboxProvider({ apiKey: "...", apiUrl: "..." });
const manager = new SandboxManagerImpl({ provider, store: dbStore });

// Execution sandbox for a specific commit
const execSandbox = await manager.ensureExecSandbox({
  projectId: "...",
  commitSha: "abc123...",
});

// Dev sandbox for a user
const devSandbox = await manager.ensureDevSandbox({
  projectId: "...",
  userId: "...",
});
```

## Coding Agent

```typescript
import { CodexAgent } from "@catamorphic/sandbox";

const agent = new CodexAgent({ apiKey: process.env.OPENAI_API_KEY });
const session = await agent.startSession({
  projectId: "...",
  userId: "...",
  sandboxId: devSandbox.id,
  workingDirectory: "/project",
});

for await (const event of agent.sendMessage(session, "Add error handling")) {
  console.log(event.type, event.content);
}
```

## Runtime Harness

The harness runs inside the sandbox via `bun run harness.ts`. It:

1. Scans project source for `"use step"` functions
2. Wraps each step with instrumentation (input, output, timing, errors)
3. Executes the workflow function with trigger data
4. Reports results to `POST /api/runs/:runId/report`

Environment variables:
- `CATAMORPHIC_RUN_ID` — Run ID
- `CATAMORPHIC_WORKFLOW_NAME` — Function name to execute
- `CATAMORPHIC_TRIGGER_DATA` — JSON trigger payload
- `CATAMORPHIC_API_URL` — API base URL for reporting
- `CATAMORPHIC_COMMIT_SHA` — Commit SHA being executed

## Database Tables

- `users` — Schema-only user model (no auth yet)
- `project_members` — Project membership with roles
- `project_sandboxes` — Tracks both execution and dev sandboxes
- `agent_sessions` — Coding agent conversation sessions
- `agent_messages` — Messages correlated with Git commit SHAs

## API Routes

- `POST /api/runs/:runId/report` — Batch report from sandbox harness
- `POST /api/projects/:projectId/agent/sessions` — Start agent session
- `GET /api/projects/:projectId/agent/sessions` — List sessions
- `GET /api/projects/:projectId/agent/sessions/:sessionId` — Get session with messages
- `POST /api/projects/:projectId/agent/sessions/:sessionId/messages` — Send message
- `DELETE /api/projects/:projectId/agent/sessions/:sessionId` — Close session

## Adding a New Coding Agent Provider

Implement the `CodingAgentProvider` interface:

```typescript
interface CodingAgentProvider {
  readonly name: string;
  startSession(opts: StartSessionOpts): Promise<ProviderSession>;
  resumeSession(providerSessionId: string): Promise<ProviderSession>;
  sendMessage(session: ProviderSession, message: string): AsyncIterable<AgentEvent>;
  dispose(session: ProviderSession): Promise<void>;
}
```

## Storage Backend Selection

- `FsBackend` — Local dev, CI, tests (default)
- `DaytonaBackend` — Production, uses Daytona sandboxes as Git repo storage

Set via `STORAGE_BACKEND=fs|daytona` env var.
