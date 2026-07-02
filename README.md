# Catamorphic

Catamorphic is a framework for building workflow automations and apps. You embed it inside your SaaS product to let your users build their own automations and dashboards with AI.

**Code is the source of truth.** Workflows and apps are stored as TypeScript code in a git repository — never as a proprietary DSL or JSON format. The parser renders that code as an intuitive visual graph for non-technical users, while technical users (and AI agents) work directly with the code. A *project* is a collection of workflows and apps: just a git repo containing TypeScript.

> **Embeddable framework.** Catamorphic ships as libraries a host application mounts in-process. The host provides auth, the user/org model, the database, and the deployment surface. There is no default identity or tenant — every request carries identity from the host's auth context. See [`INTEGRATION.md`](INTEGRATION.md) for the host integration flow.

## The developer surface

| Package | What it is |
| --- | --- |
| `@catamorphic/server-sdk` | The core SDK for your Node/Bun backend. Takes a Postgres connection (or `pg.Pool`), manages its own schema-scoped tables and migrations, and exposes projects, workflow CRUD, file I/O, and execution. |
| `@catamorphic/fastify-plugin` | A mountable Fastify plugin (`app.register(catamorphicPlugin, { core, prefix: "/api" })`) exposing the standard HTTP API for frontends. Also exports a standalone `createApp` factory for sidecar deployments. |
| `@catamorphic/react` | Headless React bindings: `CatamorphicProvider`, TanStack Query hooks, and jotai atoms. Build a fully custom UI on top of these. |
| `@catamorphic/ui` | Ready-made components: the React Flow workflow canvas, detail panel, history sidebar, AI bar. Every piece is opt-in — use the whole `WorkflowEditor` or compose the parts yourself. |
| `@catamorphic/registry` | shadcn-style copy-paste components for hosts that want to own and customize the component source. |
| `@catamorphic/api-client` | Generated OpenAPI types + `openapi-fetch` client for the HTTP API. |

Supporting packages (consumed through the surface above, importable directly for advanced wiring):

| Package | What it is |
| --- | --- |
| `@catamorphic/core` | Framework-agnostic service layer (projects/workflows/runs/plugins/secrets). The kernel behind `server-sdk` and `fastify-plugin`. |
| `@catamorphic/db` | Kysely + Postgres. Schema-scoped (default schema `catamorphic`), raw SQL migrations, programmatic `migrateToLatest`. |
| `@catamorphic/git` | Git-backed project storage (`isomorphic-git`): per-user working copies + pluggable origin remotes (`RemoteBackend`). |
| `@catamorphic/parser` | ts-morph AST → `WorkflowGraph` parser + dagre layout. |
| `@catamorphic/sandbox` | Vendor-neutral sandbox + coding-agent contracts (`SandboxProvider`, `SandboxManager`, `RunExecutor`, `CodingAgentProvider`), OTel instrumentation. |
| `@catamorphic/cloudflare` | Cloudflare backend plugin: `CloudflareSandboxProvider` (Bridge Worker) + `ArtifactsRemoteBackend` (Cloudflare Artifacts code storage). The default stack. |
| `@catamorphic/daytona` | Daytona backend plugin: `DaytonaSandboxProvider` + experimental Daytona git storage. |
| `@catamorphic/flue` | Coding-agent plugin backed by [Flue](https://flueframework.com): server-side harness driving the dev sandbox remotely. The flagship agent. |
| `@catamorphic/codex` | Coding-agent plugin backed by the OpenAI Codex SDK. |
| `@catamorphic/otel` | Tiny OpenTelemetry helpers (`@opentelemetry/api` only — the host owns the SDK/exporters). |
| `@catamorphic/runtime` | Execution harness that runs *inside* the sandbox and reports step results. |
| `@catamorphic/plugins` | Plugin manifest contract + resolvers for host-provided packages and secrets. |
| `@catamorphic/cloudflare-sandbox-bridge` | Deployable Cloudflare Worker exposing Cloudflare Sandbox over HTTP. |

A reference host app lives in [`apps/playground`](apps/playground/README.md) — Fastify + Vite/React on the Cloudflare stack (Sandbox for execution, Artifacts for code storage).

## Design principles

- **Workflows are regular code.** User-defined workflows run like normal apps — full IO, real npm dependencies, no crippled JS runtime. Execution happens inside a sandbox (Cloudflare Sandbox by default) using **Bun** to run and bundle.
- **Workflow code stays simple.** Both AI agents and humans must be able to write, edit, and understand workflows, and the parser must render them intuitively for non-technical users. See the code format below.
- **Host-injectable everything.** Database connections, storage backends, sandbox credentials, LLM credentials, and telemetry are all injected by the host — nothing is hard-coded.
- **Cloudflare-first infrastructure.** Cloudflare Sandbox for execution, Cloudflare Artifacts for git code storage (`ArtifactsRemoteBackend`; requires the closed beta). Backends ship as vendor plugin packages so hosts install only what they use. Postgres for everything stateful — including (planned) job queues and scheduling via `SKIP LOCKED`, to avoid extra infrastructure.
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

// Per request: bind the host's org + user
const client = catamorphic.forTenant(orgId).forUser(userId);
const project = await client.projects.create({ name: "Onboarding" });
```

To expose the HTTP API to your frontend:

```ts
import { catamorphicPlugin } from "@catamorphic/fastify-plugin";

app.register(catamorphicPlugin, { core: catamorphic.core, prefix: "/api" });
```

And on the frontend, wrap your tree with `CatamorphicProvider` from `@catamorphic/react` and drop in `WorkflowEditor` from `@catamorphic/ui` (or build your own UI from the hooks). See [`INTEGRATION.md`](INTEGRATION.md).

## Workflow code format

Workflows are exported async functions with a `"use workflow"` directive; steps use `"use step"`. All functions take a single destructured object parameter and carry JSDoc display metadata.

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

  await sleep("7 days");
  await sendFollowUpEmail({ to: user.email });

  return { status: "complete", userId: user.id };
}
```

## Local development

```bash
bun install

# Start a local Postgres for schema iteration + tests
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

There is no root `bun run dev` — you run a **host app** that boots catamorphic in-process. To iterate on catamorphic alongside a host, link the packages via `file:` (see `.cursor/skills/using-catamorphic/SKILL.md` → "Local dev linking").

## Scripts

```bash
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

- **Daytona** (`packages/daytona`) — runs whenever `DAYTONA_API_KEY` is set.
- **Cloudflare Sandbox** (`packages/cloudflare`, `packages/core`) — needs `CLOUDFLARE_SANDBOX_API_URL` plus the explicit opt-in `CF_SANDBOX_INTEGRATION=1` (start the bridge first: `bun run dev` in `packages/cloudflare-sandbox-bridge`).
- **Cloudflare Artifacts** (`packages/cloudflare`) — runs whenever the `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ARTIFACTS_NAMESPACE` keys are set and the account has Artifacts beta access; skips with a warning while feature-gated.

Unit tests run with no setup.

## Tech stack

- **Bun** — runtime, package manager, bundler (also inside sandboxes)
- **TypeScript** — tsgo for typechecking
- **Postgres** — all state, schema-scoped; queues/scheduling planned on the same DB
- **Cloudflare** — Sandbox (execution), Artifacts (code storage)
- **Fastify** — HTTP surface with Zod + OpenAPI (mounted by the host)
- **React Flow** — workflow visualization; **Jotai** + **TanStack Query** — frontend state
- **ts-morph** — TypeScript AST parsing
- **Kysely** — type-safe SQL
- **isomorphic-git** — portable git, no native CLI dependency
- **OpenTelemetry** — `@opentelemetry/api` instrumentation throughout
- **Turborepo** — build orchestration

## Roadmap

- **Postgres-backed queue + scheduler** — durable runs, retries, cron triggers, and `sleep()` via the host's Postgres (`SKIP LOCKED`), no extra infra (see `docs/decisions/0006`).
- **Apps** — first-class support for user-built dashboards/apps alongside workflows.
- **Persistent per-project sandboxes** — scale-to-zero and warm-start execution.
- **Compile-time step instrumentation** — replace the interim regex-based step rewriting in the run harness with an AST transform.
