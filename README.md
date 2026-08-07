# Catamorphic

**A really good place to get work done.** Catamorphic puts everything you
need for real work in one place: browser, terminals, editors, notes, and
agents that help on the same surfaces. It is free, open source, and
local-first: your projects, notes, config, and agent state are files and
databases you own, on your disk.

Catamorphic is one vision with two surfaces:

1. **The desktop app** ([`apps/desktop`](apps/desktop)): a local-first
   workspace where AI agents (Claude Code, Codex, or any API model: bring
   your own, side by side) do real work on surfaces you can *watch*: browser
   tabs, terminals, editors. You can take over any surface at any moment,
   and anything an agent produces (code, prose, config) is **inspectable
   on demand**: diffs and track-changes when a change deserves your eyes,
   trust when it doesn't. Notes, projects, and settings are plain files;
   sync rides on git. The app is also the framework's **reference
   implementation**: a working demo of what embedders can build with the
   packages below. Read the product philosophy and decision log in
   [`apps/desktop/DESIGN.md`](apps/desktop/DESIGN.md).
2. **The embeddable framework** (everything under [`packages/`](packages)):
   the engine underneath, also usable standalone: embed AI-built
   **workflows and apps** inside your own product. Workflows are durable
   TypeScript automations in git, rendered as a visual graph for
   non-technical users, executed on Postgres. Apps are real frontends your
   users build on top of those workflows, sandboxed and wired through a
   typed contract. And underneath both sits the **copilot plumbing**: the
   durable agent-session engine, multi-harness agent registry, and drop-in
   chat components that let any product ship a real companion agent, with
   the host's own skills and tools plugged in. See
   [`INTEGRATION.md`](INTEGRATION.md).

Direction, positioning, and the competitive landscape live in
[`docs/STRATEGY.md`](docs/STRATEGY.md); the strategic task list is
[`TODO.md`](TODO.md).

**Code is the source of truth.** Workflows, apps, notes: everything is
stored as plain files (TypeScript, markdown) in a git repository, never a
proprietary DSL or an opaque store. The parser renders workflow code as an
intuitive visual graph for non-technical users, while technical users and AI
agents work directly with the code. A *project* is just a git repo.

> **Greenfield: no production users yet.** Nothing here is deployed to real users, so there is no installed base to preserve. Prefer the correct design over a compatible one: change schemas, rename APIs, and delete dead paths outright rather than adding migrations-on-migrations, compatibility shims, deprecation aliases, or feature flags to protect callers that do not exist. Breaking changes are cheap right now and get expensive the day we ship. Spend that budget while it is free. (This does not license skipping tests or leaving things half-finished; it is about not paying for backwards compatibility nobody needs.)

---

# The framework

Catamorphic's engine ships as libraries a host application mounts
in-process. The desktop app is itself such a host. The host provides auth,
the user/org model, the database, and the deployment surface. There is no
default identity or tenant: every request carries identity from the host's
auth context. See [`INTEGRATION.md`](INTEGRATION.md) for the host
integration flow.

## Runs anywhere

Durable agent-and-workflow infrastructure that does **not** assume a server.
Every dependency is an axis with a heavy and a light end. Pick per axis:

| Axis | Heavy end | Light end |
| --- | --- | --- |
| Database | Network Postgres (`{ pool }` / `{ connectionString }`) | **Embedded pglite** (Kysely `PGliteDialect` via `database: { db }`; migrations run statement-by-statement so single-connection dialects just work) |
| Execution | Cloud sandboxes: `@catamorphic/cloudflare`, `@catamorphic/daytona` | **Local sandboxes** (`@catamorphic/microsandbox`), or none (read-only embed) |
| Code storage | S3-compatible bucket (`@catamorphic/s3`) or Cloudflare Artifacts | Two writable directories |
| Identity | Host org/user per request | One fixed tenant/user |
| Surface | HTTP API + React UI | In-process SDK calls, or migrations-only |

**The desktop app is the proof**: it runs the lightest column end to end
(pglite, local sandboxes, filesystem storage, no server) by design
([`apps/desktop/src/main/server/boot.ts`](apps/desktop/src/main/server/boot.ts)).
No durable-execution vendor can run entirely inside a desktop app; this one
does, and the same substrate is what offline-first agents need. Full matrix
and host shapes: [`INTEGRATION.md`](INTEGRATION.md#host-shapes-catamorphic-runs-wherever-typescript-runs).

Also worth knowing, because it's easy to miss from the package list:

- **The product teaches agents from the inside.** Every project sandbox gets
  skills staged into it (`writing-workflows`, `durable-workflows`,
  `building-apps`), so coding agents learn Catamorphic's authoring model at
  the moment they need it. The public
  [`skills/embed-catamorphic`](skills/embed-catamorphic/SKILL.md) skill
  extends the same idea to integrating Catamorphic itself.
- **One Run model.** Plain functions, persisted-continuation scopes, and
  batches all share the same Runs API, hooks, and UI: capabilities, not
  categories.
- **Observability is free for hosts.** Everything instruments against
  `@opentelemetry/api`; register your SDK and Catamorphic's spans appear in
  your traces.

## The developer surface

| Package | What it is |
| --- | --- |
| `@catamorphic/server-sdk` | The core SDK for your Node/Bun backend. Takes a Postgres connection (or `pg.Pool`), manages its own schema-scoped tables and migrations, and exposes projects, workflow CRUD, file I/O, and execution. |
| `@catamorphic/fastify-plugin` | A mountable Fastify plugin (`app.register(catamorphicPlugin, { core, prefix: "/api" })`) exposing the standard HTTP API for frontends. Also exports a standalone `createApp` factory for sidecar deployments. |
| `@catamorphic/react` | Headless React bindings: `CatamorphicProvider`, TanStack Query hooks, and jotai atoms. Build a fully custom UI on top of these. |
| `@catamorphic/ui` | Ready-made components: the React Flow workflow canvas, detail panel, history sidebar, AI bar. Every piece is opt-in: use the whole `WorkflowEditor` or compose the parts yourself. |
| `@catamorphic/registry` | shadcn-style copy-paste components for hosts that want to own and customize the component source. |
| `@catamorphic/api-client` | Generated OpenAPI types + `openapi-fetch` client for the HTTP API. |
| `@catamorphic/workflow` | Typed workflow-authoring primitives. Projects opt in directly, or a SaaS can wrap it and re-export only its approved surface. |

Supporting packages (consumed through the surface above, importable directly for advanced wiring):

| Package | What it is |
| --- | --- |
| `@catamorphic/core` | Framework-agnostic service layer (projects/workflows/runs/plugins/secrets). The kernel behind `server-sdk` and `fastify-plugin`. |
| `@catamorphic/db` | Kysely + Postgres. Schema-scoped (default schema `catamorphic`), raw SQL migrations, programmatic `migrateToLatest`. |
| `@catamorphic/git` | Git-backed project storage (`isomorphic-git`): per-user working copies + pluggable origin remotes (`RemoteBackend`). |
| `@catamorphic/parser` | ts-morph AST → `WorkflowGraph` parser + dagre layout. |
| `@catamorphic/sandbox` | Vendor-neutral sandbox + coding-agent contracts (`SandboxProvider`, `SandboxManager`, `RunExecutor`, `CodingAgentProvider`), OTel instrumentation. |
| `@catamorphic/cloudflare` | Cloudflare backend plugin: `CloudflareSandboxProvider` (default execution via Bridge Worker) + `ArtifactsRemoteBackend` (preferred Cloudflare-native code storage when available). |
| `@catamorphic/s3` | S3-compatible git origin backend for Cloudflare R2, AWS S3, MinIO, and similar stores. Default code storage until Cloudflare Artifacts access is generally available. |
| `@catamorphic/daytona` | Daytona backend plugin: `DaytonaSandboxProvider` + experimental Daytona git storage. |
| `@catamorphic/ai-sdk` | Flagship coding-agent plugin: Vercel AI SDK `ToolLoopAgent` running in the host and driving the dev sandbox remotely. |
| `@catamorphic/codex` | Coding-agent plugin backed by the OpenAI Codex SDK. |
| `@catamorphic/otel` | Tiny OpenTelemetry helpers (`@opentelemetry/api` only: the host owns the SDK/exporters). |
| `@catamorphic/runtime` | Execution harness that runs *inside* the sandbox and reports step results. |
| `@catamorphic/plugins` | Plugin manifest contract + resolvers for host-provided packages and secrets. |
| `@catamorphic/cloudflare-sandbox-bridge` | Deployable Cloudflare Worker exposing Cloudflare Sandbox over HTTP. |

A reference host app lives in [`apps/playground`](apps/playground/README.md): Fastify + Vite/React with Cloudflare Sandbox execution and S3-compatible, Artifacts, or filesystem git origins.

## Design principles

- **Workflows are regular code.** User-defined workflows run like normal apps: full IO, real npm dependencies, no crippled JS runtime. Execution happens inside a sandbox (Cloudflare Sandbox by default) using **Bun** to run and bundle.
- **Workflow code stays simple.** Both AI agents and humans must be able to write, edit, and understand workflows, and the parser must render them intuitively for non-technical users. See the code format below.
- **Host-injectable everything.** Database connections, storage backends, sandbox credentials, LLM credentials, and telemetry are all injected by the host: nothing is hard-coded.
- **Cloudflare-first infrastructure.** Cloudflare Sandbox is the default execution provider. S3-compatible storage, including Cloudflare R2, is the default git code storage until Cloudflare Artifacts access is generally available. Backends ship as vendor plugin packages so hosts install only what they use. Postgres is authoritative for runs, retries, pauses, batch-item state, queues, and scheduling via `SKIP LOCKED`.
- **OpenTelemetry throughout.** Libraries instrument against `@opentelemetry/api` only; the host registers the SDK and exporters and gets full traces for free.

Settled design decisions are recorded as ADRs in [`docs/decisions/`](docs/decisions/README.md).

## Quick start (embedding)

```ts
import { CloudflareSandboxProvider } from "@catamorphic/cloudflare";
import { createCatamorphic } from "@catamorphic/server-sdk";

// Boot once per process
const catamorphic = createCatamorphic({
  database: { connectionString: process.env.DATABASE_URL! }, // or { pool }
  storage: {
    projectsPath: process.env.CATAMORPHIC_PROJECTS_PATH!,
    remotesPath: process.env.CATAMORPHIC_REMOTES_PATH!,
  },
  // Backend plugins: @catamorphic/cloudflare (default) or @catamorphic/daytona
  sandboxProvider: new CloudflareSandboxProvider({
    apiUrl: process.env.CLOUDFLARE_SANDBOX_API_URL!,
    apiKey: process.env.CLOUDFLARE_SANDBOX_API_KEY,
  }),
});
await catamorphic.migrate(); // idempotent, schema-scoped

// Worker startup is explicit and host-owned.
const executionWorker = catamorphic.startExecutionWorker({ concurrency: 4 });

// Per request: bind the host's org + user
const client = catamorphic.forTenant(orgId).forUser(userId);
const project = await client.projects.create({ name: "Onboarding" });
const run = await client.runs.triggerProduction({
  projectId: project.id,
  workflowName: "welcomeUser",
  input: { email: "ada@example.com" },
});
```

To expose the HTTP API to your frontend:

```ts
import { catamorphicPlugin } from "@catamorphic/fastify-plugin";

app.register(catamorphicPlugin, { core: catamorphic.core, prefix: "/api" });
```

And on the frontend, wrap your tree with `CatamorphicProvider` from `@catamorphic/react` and drop in `WorkflowEditor` from `@catamorphic/ui` (or build your own UI from the hooks). See [`INTEGRATION.md`](INTEGRATION.md).

## Workflow code format

There is one public Workflow model and one public Run model. Authoring syntax
selects capabilities; it does not create user-facing execution categories.

### Plain workflow functions

A plain workflow is an exported async function whose body contains the exact
`"use workflow"` directive. Steps use the exact `"use step"` directive. Plain
functions run as normal code, but operations do not have persisted continuation
between them. All functions take one destructured object parameter and carry
JSDoc display metadata.

```typescript
/**
 * @displayname Welcome New User
 * @description Onboard a new user
 */
export async function welcomeUser({
  email,
  name,
}: {
  email: string;
  name: string;
}) {
  "use workflow";

  const user = await createUser({ email, name });
  await sendWelcomeEmail({ to: user.email, name: user.name });

  if (user.plan === "premium") {
    await assignPremiumBenefits({ userId: user.id });
  }

  await sendFollowUpEmail({ to: user.email });

  return { status: "complete", userId: user.id };
}
```

### Persisted workflow scopes

Use `defineWorkflow(({ defineBoundary, defineBatch }) => ({ steps: [...] }))`
when a Workflow needs persisted continuation. A boundary is one atomic retry
scope: if its callback fails, all operations in that callback retry together. A
batch scope is paged per-item processing with an optional sink. `defineBatchStep` is a
physical coalescing primitive for compatible calls inside `defineBatch.process`;
it does not define a Workflow or a separate logical step scope.

```typescript
import { defineWorkflow } from "@catamorphic/workflow";

export const processAccount = defineWorkflow(
  ({ defineBoundary, defineBatch }) => ({
    steps: [
      defineBoundary<{ accountId: string }, { accountId: string }>({
        retry: { maxAttempts: 3 },
        run: async ({ input }) => prepareAccount({ accountId: input.accountId }),
      }),
      defineBatch({
        source: async ({ input }: { input: { accountId: string } }) => ({
          source: recordsSource,
          config: { accountId: input.accountId },
        }),
        process: async ({ item }: { item: AccountRecord }) =>
          processRecord({ record: item }),
        sink: resultSink,
      }),
    ],
  }),
);
```

The parser and UI expose capabilities such as persisted continuation, batch
processing, and cancellation. There is no public stage concept, category
switch, or separate Run family for these capabilities.

### Long-lived journeys: correlation keys, signals, shared rate budgets

A run may carry a **correlation key**: a host-meaningful identity for its
subject (a contact, an account, a subscription). It is unique among live runs of
the same workflow, which makes it at once an enrollment idempotency key and the
address external events use to reach the run. A boundary declares the shared
third-party budgets it draws on; buckets are keyed per tenant, so every workflow
naming the same `globalKey` draws on one budget.

```typescript
export const nurtureContact = defineWorkflow(({ defineBoundary }) => ({
  controls: { cancel: true },
  steps: [
    defineBoundary({
      rateLimits: [
        { globalKey: "email", capacity: 500, refillRatePerSecond: 100 },
      ],
      run: async ({ input, pause }: BoundaryContext<{ contactId: string }>) => {
        await sendWelcomeEmail({ contactId: input.contactId });
        return pause<{ clicked: boolean }, { contactId: string }>({
          signal: "reply",
          timeout: "72h",
          state: { contactId: input.contactId },
        });
      },
    }),
    defineBoundary({
      // A different step, a different provider, a different budget.
      rateLimits: [
        { globalKey: "whatsapp", partitionKey: "sender-1", capacity: 80, refillRatePerSecond: 20 },
      ],
      run: async ({ input }) => sendWhatsApp({ contactId: input.state.contactId }),
    }),
  ],
}));
```

```ts
// Enrolling twice for the same contact is a no-op, so webhook redelivery is safe.
await client.runs.triggerProduction({
  projectId, workflowName: "nurtureContact",
  input: { contactId: "contact-42" },
  correlationKey: "contact-42",           // onConflict: "ignore" | "error" | "restart"
});

// External events address the contact, not a run id.
await client.runs.signalByKey({
  projectId, workflowName: "nurtureContact",
  correlationKey: "contact-42",
  signal: "reply", idempotencyKey: replyEventId, value: { clicked: true },
});

// Opting out ends the journey wherever it sits. Resolves null if none was live.
await client.runs.cancelByKey({
  projectId, workflowName: "nurtureContact",
  correlationKey: "contact-42", reason: "unsubscribed",
});
```

Waiting for capacity is not failure: a boundary that cannot reserve is
rescheduled without consuming a retry and without holding a sandbox. When a
provider answers with a 429, report it with `rateLimited({ retryAfterMs })`:
that blocks every workflow sharing the account, not just the run that hit it.

Hosts bound what any one tenant may consume from these shared resources via
`catamorphic.tenantPolicies`. It is SDK-only and never exposed over HTTP, so a
tenant cannot raise its own limits:

```ts
await catamorphic.tenantPolicies.upsert({
  tenantId,
  maxConcurrentJobs: 32,     // ceiling on simultaneously leased jobs
  maxActiveRuns: 50_000,     // ceiling on live runs; bounds enrollment fan-out
  queueWeight: 4,            // relative share of each claim batch
  retentionDays: 365,        // overrides the installation retention window
  rateLimitOverrides: {      // can tighten an author's bucket, never loosen it
    whatsapp: { capacity: 40, refillRatePerSecond: 10 },
  },
});
```

### Retention

Finished runs are purged after **90 days by default**, along with everything
hanging off them: jobs, events, step attempts, batch items and their steps.
Without this, a daily 100k-item batch adds on the order of 1.5M rows a day and
never gives any back.

The sweep runs inside the execution worker, so it needs no wiring. Change the
window, or turn it off entirely, at construction:

```ts
const catamorphic = createCatamorphic({
  database,
  storage,
  retention: { runRetentionDays: 30 }, // or { enabled: false } to keep forever
});
```

Individual tenants can be given a longer or shorter window with
`retentionDays` above.

See [ADR 0027](docs/decisions/0027-correlation-keys-and-external-signals.md),
[ADR 0028](docs/decisions/0028-shared-rate-budgets-and-tenant-execution-policy.md),
and [ADR 0030](docs/decisions/0030-run-retention.md).

## Local development

```bash
bun install

# Start local dev services: Postgres, plus an OTel collector (:4317/:4318)
# backed by ClickHouse (:8124 HTTP, :19001 native) for trace storage
docker compose up -d

# Apply migrations + regenerate Kysely types (scoped to the `catamorphic` schema)
DATABASE_URL="postgresql://catamorphic:catamorphic@localhost:5432/catamorphic" bun run db:migrate
DATABASE_URL="postgresql://catamorphic:catamorphic@localhost:5432/catamorphic" bun run db:codegen

# Build everything
bun run build

# Regenerate the OpenAPI spec + typed api-client after route/DTO changes
cd packages/fastify-plugin && bun run generate-spec
cd ../api-client && bun run generate
```

Catamorphic itself is embed-only: in production you run a **host app** that boots it in-process. For local development, the root `bun run dev` boots the reference host (the playground) together with its dev dependencies: it runs `docker compose up -d --wait` (Postgres + OTel collector + ClickHouse), builds the workspace packages the playground consumes, then starts the Cloudflare sandbox bridge (`:8787`) and the playground (API `:8500`, Vite `:5173`) side by side. Which Postgres the playground connects to is controlled by `DATABASE_URL` in `apps/playground/.env`. To iterate on catamorphic alongside your own host instead, link the packages via `file:` (see `.cursor/skills/using-catamorphic/SKILL.md` → "Local dev linking").

## Scripts

```bash
bun run dev        # Dev stack: docker compose infra + sandbox bridge + playground
bun run build      # Build all packages
bun run test       # Run all tests
bun run typecheck  # Typecheck all packages with tsgo
bun run lint       # Lint with Biome
bun run lint:fix   # Auto-fix lint issues
bun run db:migrate # Apply migrations to the DB pointed at by DATABASE_URL
bun run db:codegen # Regenerate Kysely types from the `catamorphic` schema
bun run db:reset   # Drop + recreate the catamorphic schema (dev only)
bun run db:status  # Show applied / pending migrations
```

## Testing

Tests use **Vitest**, orchestrated by Turborepo.

```bash
bun run test                                   # everything
bun run --filter @catamorphic/parser test      # one package
cd packages/parser && bun run test src/__tests__/parser.test.ts  # one file
```

Integration tests hit the **real services** using the keys in the repo root `.env` (loaded automatically by the vitest config) and skip themselves when credentials are absent:

- **Daytona** (`packages/daytona`): runs whenever `DAYTONA_API_KEY` is set.
- **Cloudflare Sandbox** (`packages/cloudflare`, `packages/core`): needs `CLOUDFLARE_SANDBOX_API_URL` plus the explicit opt-in `CF_SANDBOX_INTEGRATION=1` (start the bridge first: `bun run dev` in `packages/cloudflare-sandbox-bridge`).
- **Cloudflare Artifacts** (`packages/cloudflare`): runs whenever the `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ARTIFACTS_NAMESPACE` keys are set and the account has Artifacts beta access; skips with a warning while feature-gated.

Unit tests run with no setup.

## Tech stack

- **Bun**: runtime, package manager, bundler (also inside sandboxes)
- **TypeScript**: tsgo for typechecking
- **Postgres**: all state, schema-scoped; run queues, retries, pauses, and scheduling use the same DB
- **Cloudflare**: Sandbox (execution), Artifacts (code storage)
- **Fastify**: HTTP surface with Zod + OpenAPI (mounted by the host)
- **React Flow**: workflow visualization; **Jotai** + **TanStack Query**: frontend state
- **ts-morph**: TypeScript AST parsing
- **Kysely**: type-safe SQL
- **isomorphic-git**: portable git, no native CLI dependency
- **OpenTelemetry**: `@opentelemetry/api` instrumentation throughout
- **Turborepo**: build orchestration

## Roadmap

- **Scheduled and cron triggers**: build trigger management on the existing Postgres execution queue without adding infrastructure.
- **Apps**: first-class support for user-built dashboards/apps alongside workflows.
