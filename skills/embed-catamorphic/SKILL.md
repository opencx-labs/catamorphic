---
name: embed-catamorphic
description: >
  Embed Catamorphic (user-facing AI workflows, apps, and coding agents)
  inside any TypeScript host: a multi-tenant SaaS backend, a desktop or
  local-first app, a single-tenant internal tool, or a read-only reporting
  embed. Use when the user wants THEIR users (or themselves) to build
  automations, workflows, or apps with AI inside their product; wants to add
  an AI copilot, assistant, or companion agent to their product (chat that
  does real work, not a FAQ bot); wants durable background jobs with a
  visual editor non-technical users can read; or asks to integrate/embed
  Catamorphic. Covers host-shape selection, install, boot, identity wiring,
  HTTP + React surfaces, chat components, and execution sandboxes.
---

# Embedding Catamorphic

Catamorphic is a free, open-source (permissive license), embed-only
framework: the host app mounts it in-process and gets AI-built workflows and
apps (real TypeScript in a real git repo, rendered as a visual graph for
non-technical users, executed durably on Postgres). There is no Catamorphic
server to deploy and no Catamorphic account: the host owns auth, tenancy,
database, and deployment.

It is also the fastest path to a **product copilot**: the plumbing around a
companion agent ships ready-made. Durable agent sessions (interrupted turns
settle honestly, transient failures auto-retry, lost in-memory sessions
re-anchor from the transcript), a registry of named agents over pluggable
harnesses (AI SDK on any model, Claude Code, Codex; swappable per turn, no
restart), drop-in chat components (`agent-chat`, `chat-timeline`,
`sessions-list` via `@catamorphic/registry`) over headless hooks
(`useAgentChat`, `useAgentSessions`, `useSendAgentMessage`), and the host's
own skills and tools plugged into the agent. If the user's ask is "add an
AI assistant/copilot to our product", this is the shape to build: mount the
engine, drop in the chat, plug in their agent setup.

The entire implementation is **open source**:
https://github.com/opencx-labs/catamorphic. When docs leave a question open,
read the source instead of guessing: each `packages/<name>/README.md`
documents its package, `docs/decisions/` holds the ADRs behind settled
designs, and `apps/desktop/src/main/server/boot.ts` is a complete real-world
embedding (the lightest host shape). Cloning the repo for reference is a
normal, expected part of integrating.

Canonical deep docs (read before writing code):

- Integration guide (includes the host-shapes matrix):
  https://raw.githubusercontent.com/opencx-labs/catamorphic/main/INTEGRATION.md
- Overview + workflow code format:
  https://raw.githubusercontent.com/opencx-labs/catamorphic/main/README.md

## Step 1: identify the host shape (do NOT assume a server)

Every dependency is an axis with a heavy and a light end; pick per axis, not
as a bundle. Catamorphic Desktop itself embeds the framework in an Electron
app with **pglite and local sandboxes: no server, no network Postgres**,
so "I don't run Postgres" is never a blocker.

| Axis | Options |
| --- | --- |
| Database | Network Postgres (`{ pool }` / `{ connectionString }`) **or** embedded pglite (Kysely on `PGliteDialect`, passed as `database: { db }`) |
| Execution | Cloud sandboxes (`@catamorphic/cloudflare` or `@catamorphic/daytona`) **or** local sandboxes (`@catamorphic/microsandbox`) **or** none (read-only embed) |
| Code storage | Writable directories (`projectsPath` + `remotesPath`) **or** S3-compatible bucket via `@catamorphic/s3` (R2, S3, MinIO) |
| Identity | Host org/user per request **or** one fixed tenant/user for single-user apps |
| Surface | SDK-only in-process, +HTTP (`@catamorphic/fastify-plugin`), +React UI (`@catamorphic/react`, `@catamorphic/ui`), or migrations-only (`@catamorphic/db`) |

Typical shapes: multi-tenant SaaS (heavy ends), desktop/local-first app
(light ends, reference: `apps/desktop/src/main/server/boot.ts` in the
repo), single-tenant internal tool (mixed), reporting-only (`@catamorphic/db`
migrations + SQL joins).

Ask the user only the questions the axes leave open: which database they
have, where files can live, and whether/where workflow execution should run.

## Step 2: boot (example: SaaS shape; swap axes per Step 1)

```bash
bun add @catamorphic/server-sdk @catamorphic/fastify-plugin @catamorphic/cloudflare
```

```ts
import { CloudflareSandboxProvider } from "@catamorphic/cloudflare";
import { createCatamorphic } from "@catamorphic/server-sdk";

// Boot once per process
export const catamorphic = createCatamorphic({
  database: { pool: hostPgPool }, // or { connectionString }, or { db } (Kysely: pglite goes here)
  storage: {
    projectsPath: process.env.CATAMORPHIC_PROJECTS_PATH!,
    remotesPath: process.env.CATAMORPHIC_REMOTES_PATH!,
  },
  sandboxProvider: new CloudflareSandboxProvider({
    apiUrl: process.env.CLOUDFLARE_SANDBOX_API_URL!,
    apiKey: process.env.CLOUDFLARE_SANDBOX_API_KEY,
  }), // or new MicrosandboxSandboxProvider() from @catamorphic/microsandbox; omit for read-only
});
await catamorphic.migrate(); // idempotent, schema-scoped, pglite-safe

// Start exactly once in processes that should execute runs (never implicit)
const worker = catamorphic.startExecutionWorker({ concurrency: 4 });

// Per request: bind the host's verified identity (fixed ids in single-user apps)
const scoped = catamorphic.forTenant(orgId).forUser(userId);
const project = await scoped.projects.create({ name: "onboarding" });
const run = await scoped.runs.triggerProduction({
  projectId: project.id,
  workflowName: "welcomeUser",
  input: { email: "ada@example.com" },
});
```

## Custom trigger kinds (host-defined events that run workflows)

When the host has domain events — "Ticket Created", "AI Tool Call",
"Order Shipped" — define trigger kinds so user workflows can subscribe to
them. Workflows declare `triggers: [trigger("ticket.created", config)]` in
code; the host fires the kind with a typed payload and every subscribed
workflow at the production commit runs.

```ts
import { defineTriggerKind } from "@catamorphic/server-sdk";
import { z } from "zod";

export const ticketCreated = defineTriggerKind({
  name: "ticket.created",
  description: "A support ticket was created",
  display: { label: "Ticket Created", icon: "bell", color: "#ca8a04" },
  payload: z.object({
    ticketId: z.string(),
    subject: z.string(),
    priority: z.enum(["low", "high"]),
  }),
  // Constant per-workflow config the kind demands of subscribers; e.g. an
  // AI tool-call kind requires the tool description here.
  config: z.object({ onlyPriority: z.enum(["low", "high"]).optional() }),
  correlationKey: (p) => p.ticketId, // optional enrollment identity
});

// Register at boot:
createCatamorphic({ ..., triggerKinds: [ticketCreated] });

// Fire from the host's domain code (e.g. inside createTicket):
const result = await scoped.triggers.fire({
  projectId,
  kind: ticketCreated,       // pass the definition value → payload is typed
  payload: { ticketId, subject, priority: "high" },
  mode: "async",             // or "sync" — see below
});

// Introspect (e.g. build AI tool definitions from bound workflows):
const bindings = await scoped.triggers.list({ projectId, kind: ticketCreated });
// → [{ workflowName, config /* typed from the kind */, canSuspend, inputParameters }]
```

Semantics that keep this correct:

- **Types by construction.** The zod schemas are the single source of truth:
  they validate payloads at fire time, configs when a commit is first
  scanned, and generate `workflows/src/catamorphic-triggers.d.ts` inside each
  project so `trigger()` type-checks for workflow authors. Call
  `scoped.triggers.syncTypes({ projectId })` at project provisioning and
  whenever the kind set changes — it writes every generated projection in
  one drift-checked commit (trigger kinds, plus a typed
  `apps/<name>/src/catamorphic-app-api.d.ts` client interface per app
  workspace) and returns `{ paths, updated }`; a no-op when fresh.
- **Workflow IO schemas ride along.** Each binding from
  `scoped.triggers.list` carries `inputSchema`/`outputSchema` — real JSON
  Schemas projected from the workflow's TS types — so AI-tool-call
  embedders hand them straight to an agent harness (description from
  config, schema from code). Run input is validated against the same
  schema at trigger time (`RunInputInvalidError`), and the MCP workflow
  tools serve them as `inputSchema`.
- **Sync firing runs until the first wait.** `mode: "sync"` executes the
  run's boundaries inline in your request and returns
  `{ status: "completed", output }` — unless the workflow pauses, backs off
  a retry, hits a rate limit, enters a batch, or exhausts the `budgetMs`
  (default 30s), in which case you get `{ status: "suspended", suspendedOn,
  runId }` and the run continues on the queue. Always handle both arms.
  A binding with `canSuspend: false` is guaranteed to settle inline.
- Bindings are frozen per (project, production commit) in
  `trigger_bindings` — firing reads a table, never a source parse. A commit
  whose bindings name unknown kinds or fail config validation fails closed
  with `TriggerBindingsInvalidError`.
- Fire is fan-out: every bound workflow runs. Use `workflows: ["name"]` to
  target a subset (e.g. the one workflow the AI invoked as a tool), and
  `correlationKey`/`onConflict` for enrollment dedupe, same as
  `runs.triggerProduction`.
- HTTP surface: `GET /trigger-kinds`, `GET /projects/:id/triggers`,
  `POST /projects/:id/triggers/:kind/fire`,
  `POST /projects/:id/triggers/sync-types`.

## Validating projects outside the agent (local editors, CI)

Every project is seeded with `scripts/check.ts` — a thin, project-owned
script (edit it freely; the logic lives in the `@catamorphic/parser`
devDependency, which sandbox installs strip automatically):

```bash
bun run check                # parse + validate + generated-type drift; exit 1 on errors
bun run check -- --write     # regenerate apps/<name>/src/catamorphic-app-api.d.ts
bun run check -- --host URL  # also validate trigger bindings against a live host
```

Point CI at `bun install && bun run check` plus `tsc` over `workflows/` and
`apps/` and a human editing the project in their own editor gets the same
guarantees the agent does: stale generated types fail the build instead of
silently type-checking app code against the wrong contract.

## Step 3: surfaces (only what the host needs)

HTTP for frontends (required for the React UI):

```ts
import { catamorphicPlugin } from "@catamorphic/fastify-plugin";
app.register(catamorphicPlugin, { core: catamorphic.core, prefix: "/api" });
```

Every HTTP request needs `X-Catamorphic-Tenant-Id` and `X-External-User-Id`.
**Set them server-side from the host's verified session. Never accept them
from the browser.** (In a desktop app the embedded server sets fixed values.)

React: wrap the tree in `CatamorphicProvider` (`@catamorphic/react`), then
drop in `WorkflowEditor` from `@catamorphic/ui` or compose from headless
hooks (`useProjects`, `useRuns`, `useTriggerRun`, `useAgentSessions`, …).
shadcn-style source-owned components: `@catamorphic/registry`.

## Rules that keep integrations correct

- Tenant = host org id, upserted on first use. Never pre-register. External
  user id is never persisted; it scopes git working copies and commit
  authorship.
- All exports are Workflows; every invocation is a Run. Every workflow is an
  exported `defineWorkflow(({ defineBoundary, defineBatch }) => …)` value —
  boundaries for retry scopes, pauses/signals; batches for collections; IO in
  `"use step"` functions called from boundary bodies. Every run executes a
  deployed commit. Never invent a separate "batch run" concept: capabilities
  live on the one Run model.
- Migrations (`catamorphic.migrate()` / `npx catamorphic-db migrate`) are
  idempotent, schema-scoped, and run statement-by-statement so
  single-connection dialects (pglite) work.
- Catamorphic never destroys host-owned pools or Kysely instances;
  `close()` only closes what it created. Stop worker handles on shutdown.
- Observability is `@opentelemetry/api` only: if the host registers an OTel
  SDK, spans (`workflow.run`, `sandbox.*`, …) appear automatically.

## How to run this integration as an agent

1. Identify the host shape (Step 1) and confirm the open axis choices with
   the user before writing code.
2. Read INTEGRATION.md for the surfaces you're wiring; don't improvise API
   shapes: every public method takes one keyed object parameter. When
   anything is ambiguous, consult the source (package READMEs, ADRs, the
   desktop app's boot.ts): it's open and meant to be read.
3. Wire identity from the host's real auth middleware (or fixed ids in
   single-user hosts), not placeholders.
4. Verify end to end: migrate → create a project → write a workflow file →
   deploy → trigger a run → read run status via the same scoped client (runs
   execute deployed commits, so deploy before triggering). Only then mount
   HTTP and UI.
5. If the host registered trigger kinds: sync types into a project, write a
   workflow with `triggers: [trigger("kind", config)]`, deploy, `fire` the
   kind, and assert the run enrolled (async) or settled/suspended honestly
   (sync).
