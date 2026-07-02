# Agent Instructions

## Project Overview

Catamorphic is a framework for building workflow automations and apps, embedded by SaaS products so their users can build automations and dashboards with AI. Workflows and apps are TypeScript code — **the code is strictly the source of truth**; we never invent DSLs or JSON formats for workflow logic. A *project* is a git repo of TypeScript that exports workflows (and, in the future, apps). The parser converts the TypeScript AST into a visual graph rendered by React Flow so non-technical users can understand and (via AI agents) build workflows, while technical users edit the code directly.

Workflow code must stay simple: easy for AI agents and humans to write and edit, and intuitive to render for non-technical users. User workflows run like **regular apps** — full IO, real npm dependencies, no restricted JS runtime. Execution happens in sandboxes using **Bun**.

### Embeddable framework positioning (READ THIS FIRST)

**Catamorphic ships as libraries a host application mounts in-process.** There is no standalone product, no default identity, and no root `bun run dev`. The host provides auth, user/org model, database, and the deployment surface. (A playground demo app that acts as a reference host is on the roadmap; libraries must never depend on it.)

Concrete implications for any change you make:

- Prefer designs that are **host-injectable**: DB connections/schemas, auth context, storage, sandbox credentials, LLM credentials, and telemetry must be configurable/injectable — never hard-coded.
- Avoid assumptions that only hold in a single-process demo (a single global DB, a single user, a specific env layout, port, or filesystem path).
- When adding migrations, API routes, or packages, think first about how a host consumes them (library import, mountable Fastify plugin, schema-scoped migrations, generated client types). See `INTEGRATION.md`.
- Do not re-introduce a standalone boot, a default tenant, or a default user. Every request carries identity from the host's auth context.
- When a tradeoff exists between "nice for a demo" vs. "nice for embedding", embedding wins unless the user explicitly says otherwise.

### Infrastructure priorities

- **Cloudflare-first.** Cloudflare Sandbox is the default execution provider and Cloudflare Artifacts the default git code storage (both in `@catamorphic/cloudflare`; Daytona is the maintained alternate in `@catamorphic/daytona`). Backends are vendor plugin packages — hosts construct providers explicitly at boot (see ADR 0008 and `apps/playground/src/server/boot.ts`). See `CLOUDFLARE.md`.
- **Postgres for everything stateful.** Tables live in a dedicated schema (default `catamorphic`). When you need queues or scheduling, build them on the same Postgres (`SKIP LOCKED`) instead of adding infrastructure.
- **OpenTelemetry throughout.** Libraries instrument with `@opentelemetry/api` only (via `@catamorphic/otel`); the host owns the SDK/exporters. New service methods on hot paths (runs, deploys, sandbox ops, project mutations) should get spans with `catamorphic.*` attributes.
- **Bun** for running, bundling, and inside sandboxes.

## Design Decisions (ADRs)

Settled decisions live in `docs/decisions/` as short ADRs, indexed in `docs/decisions/README.md`.

**When you and the user settle a non-trivial design decision (architecture, package boundaries, storage, execution, naming, dependencies), record it as a new ADR in the same change.** Copy `docs/decisions/0000-template.md`, number it sequentially, keep it under a page, and update the index. When a decision supersedes an old one, mark the old ADR as superseded rather than deleting it. Do not deviate from accepted ADRs without explicit user approval.

## Monorepo Structure

Public developer surface:

- `packages/server-sdk` — **`@catamorphic/server-sdk`**: core backend SDK. `createCatamorphic({ database, storage, sandboxProvider?, pluginResolver? })` accepts a `pg.Pool` or connection string, manages schema-scoped tables (`catamorphic.migrate()`), and exposes tenant/user-scoped clients.
- `packages/fastify-plugin` — **`@catamorphic/fastify-plugin`**: mountable Fastify plugin (`catamorphicPlugin`) + standalone `createApp` factory with Zod schemas and OpenAPI spec.
- `packages/react` — headless React bindings (provider, TanStack Query hooks, jotai atoms).
- `packages/ui` — React Flow editor components (canvas, panels, AI bar); all opt-in/composable.
- `packages/registry` — shadcn-style copy-paste component registry.
- `packages/api-client` — generated OpenAPI types + openapi-fetch client.

Internal packages:

- `packages/core` — framework-agnostic service layer (the kernel behind server-sdk and fastify-plugin).
- `packages/db` — Kysely instance, schema-scoped raw SQL migrations, programmatic `migrateToLatest`, codegen types.
- `packages/git` — vendor-neutral git-backed project storage (isomorphic-git): `StorageBackend`/`RemoteBackend` contracts, `ProjectManager`, git-sync, filesystem backends.
- `packages/parser` — ts-morph AST-to-WorkflowGraph parser.
- `packages/sandbox` — vendor-neutral sandbox + coding-agent contracts (`SandboxProvider`, `SandboxManager`, `RunExecutor`, `CodingAgentProvider`), `instrumentSandboxProvider`, plugin-doc staging helpers. No vendor SDKs here.
- `packages/cloudflare` — **`@catamorphic/cloudflare`** backend plugin: `CloudflareSandboxProvider` (Bridge Worker client), `ArtifactsClient` + `ArtifactsRemoteBackend` (Cloudflare Artifacts code storage). Default stack.
- `packages/daytona` — **`@catamorphic/daytona`** backend plugin: `DaytonaSandboxProvider`, experimental Daytona git storage.
- `packages/flue` — **`@catamorphic/flue`** coding-agent plugin: `FlueCodingAgent` (Flue harness runs on the host server, operates on the dev sandbox remotely) + `catamorphicSandbox` adapter. Flagship agent; used by the playground.
- `packages/codex` — **`@catamorphic/codex`** coding-agent plugin: `CodexAgent` (OpenAI Codex SDK).
- `packages/otel` — OpenTelemetry helpers (`getTracer`, `withSpan`) over `@opentelemetry/api`.
- `packages/runtime` — workflow execution harness (runs inside the sandbox).
- `packages/plugins` — plugin manifest contract + resolvers (see [packages/plugins/README.md](packages/plugins/README.md)).
- `packages/cloudflare-sandbox-bridge` — deployable Worker exposing Cloudflare Sandbox over HTTP.

Apps:

- `apps/playground` — reference host app (Fastify + Vite/React) on the Cloudflare stack. Has its own `bun run dev`; catamorphic itself remains embed-only.

## Skills

- `.cursor/skills/plugin-e2e-integration/SKILL.md` — Business-agnostic end-to-end plugin integration flow
- `.cursor/skills/using-catamorphic/SKILL.md` — Embedding catamorphic in a host app
- `.cursor/skills/embedding-guide/SKILL.md`, `api-type-safety`, `code-first-architecture`, `database-conventions`, `sandbox-agent-integration`, `workflow-code-conventions`

## Verification Checklist

After **every** change, run all applicable checks before considering it complete. Do not skip any step.

### 1. Lint

```bash
bun run lint # from root — runs biome check on entire monorepo
bun run lint:fix # auto-fix safe issues
```

Zero errors and zero warnings. Use `bunx biome check --write --unsafe .` for unsafe fixes, then verify.

### 2. Typecheck

```bash
turbo typecheck # all packages from root
```

Every `.ts`/`.tsx` change must pass with zero errors.

### 3. Build

```bash
turbo build # all packages from root
```

### 4. Tests

```bash
turbo test # all packages from root
```

All existing tests must pass.

### 5. Browser verification (after UI/integration changes)

Catamorphic has no standalone UI. Rebuild the affected packages, refresh the `file:` links in the host app, and verify in the **host's** browser. Check: workflows render, zero browser console errors, zero dev overlay issues, no hydration mismatches.

### 6. Migration sync

```bash
bun run db:migrate && bun run db:codegen
```

### 7. API spec sync (after route/DTO changes)

```bash
cd packages/fastify-plugin && bun run generate-spec
cd packages/api-client && bun run generate
```

### 8. Never commit

Do not run `git add`, `git commit`, or `git push` unless the user explicitly asks.

## Design Principles

Settled decisions — do not deviate without explicit user approval. ADRs in `docs/decisions/`; operational detail in `.cursor/rules/`:

- **Project model, git versioning, templates, DB types** → `project-model.mdc`
- **Sandbox execution, providers, run lifecycle, instrumentation** → `sandbox-execution.mdc`
- **Editor UI: history sidebar, run panel, state management** → `playground-ui.mdc`
- **Canvas layout, nodes, edges, read-only behavior** → `graph-design.mdc`
- **Parser node types, containers, source ranges, provenance** → `parser-conventions.mdc`
- **Detail panel, code editor, bidirectional linking** → `panel-editor.mdc`
- **Test structure, parallelism, isolation, skip patterns** → `testing-conventions.mdc`

## Code Conventions

### Workflow Code Format

Workflows use `"use workflow"` directive. Steps use `"use step"` directive.

```typescript
export async function myWorkflow({ input }: { input: string }) {
 "use workflow";
 const result = await myStep({ data: input });
 return { result };
}
```

### Step Functions

All step functions take a **single destructured object parameter**. Every step function and every parameter **must** have JSDoc metadata with a `@displayname`.

```typescript
/**
 * @displayname Send Welcome Email
 * @icon mail
 * @param to - @displayname Recipient | @description Email address to send to
 * @param name - @displayname Recipient Name | @description The user's display name
 */
async function sendWelcomeEmail({ to, name }: { to: string; name: string }) {
 "use step";
}
```

Display name guidelines: step names are short action phrases ("Send Email"); parameter names are descriptive labels (`orderId` → "Order ID"). The UI converts TS types to friendly labels automatically (`string` → "Text", `boolean` → "True or False", etc.).

### TypeScript Style

See `typescript-style.mdc`. Key points: object params over positional, no `any`, no `as` casts, minimize `let`.

### API Routes

Define Zod schemas first, then register routes with `fastify-type-provider-zod`. Route URLs are prefix-relative (no hard-coded `/api`) — the plugin is mounted with `prefix: "/api"` by `createApp` and by hosts. After adding routes:

```bash
cd packages/fastify-plugin && bun run generate-spec
cd packages/api-client && bun run generate
```

### Database Changes

Forward-only raw SQL migrations in `packages/db/migrations/`. After changes:

```bash
bun run db:migrate # apply pending migrations
bun run db:codegen # regenerate TypeScript types
```

### Instrumentation

Use `@catamorphic/otel` (`getTracer("@catamorphic/<package>")` + `withSpan`). Attribute names use the `catamorphic.` prefix (`catamorphic.project.id`, `catamorphic.run.id`, `catamorphic.tenant.id`, `catamorphic.workflow.name`). Sandbox providers are auto-wrapped by `instrumentSandboxProvider` inside `CatamorphicCore` — do not double-wrap.

## Build Order

```
db → core → fastify-plugin → api-client
otel → sandbox → core
otel → core
git → core
parser → core
parser → ui
core → server-sdk
api-client → react → ui → registry
```
