# Agent Instructions

## Project Overview

Catamorphic AI is a code-first workflow builder. Workflows are TypeScript code, not JSON. The parser converts TypeScript AST into a visual graph rendered by React Flow. Non-technical users can build workflows using AI, and technical users can edit the code directly.

### Embed-only positioning (READ THIS FIRST)

**Catamorphic is embed-only.** It ships as a set of libraries that a host application (e.g. OpenCX) mounts in-process. There is no standalone product, no demo app, no default identity, and no `bun run dev`. The host provides auth, user/org model, database (or schema), and the deployment surface.

Concrete implications for any change you make:

- Prefer designs that are **host-injectable**: DB connections/schemas, auth context, storage, sandbox credentials, LLM credentials, and telemetry should all be configurable/injectable — never hard-coded.
- Avoid assumptions that only hold in a single-process demo (e.g. a single global DB, a single user, a specific env layout, a specific port, a specific filesystem path).
- When adding migrations, API routes, or packages, think first about how a host consumes them (library import, mountable Fastify plugin, schema-scoped migrations, generated client types). See `INTEGRATION.md`.
- Do not re-introduce a standalone boot, a default tenant, or a default user. Every request carries identity from the host's auth context.
- When a tradeoff exists between "nice for a demo" vs. "nice for embedding", embedding wins unless the user explicitly says otherwise.

## Monorepo Structure

- `packages/parser` — ts-morph AST-to-WorkflowGraph parser
- `packages/ui` — React Flow editor components (embeddable)
- `packages/server` — Fastify app factory (`createApp({ core })`) with Zod schemas + OpenAPI spec; mounted by the host
- `packages/db` — Kysely instance, migrations, codegen types
- `packages/plugins` — Plugin manifest contract + resolvers (see [packages/plugins/README.md](packages/plugins/README.md))
- `packages/runtime` — Workflow execution harness (runs inside sandbox)
- `packages/sandbox` — Sandbox providers (Daytona + Cloudflare) + coding agent (Codex SDK). **Daytona is the default until further notice** — the host's boot code (see OpenCX's `backend/src/catamorphic/boot.ts`) prefers Daytona whenever `DAYTONA_API_KEY` is set, even when Cloudflare env vars are also populated. See `CLOUDFLARE.md`.
- `packages/api-client` — Generated OpenAPI types + openapi-fetch client
- `packages/registry` — shadcn-style copy-paste component registry (served by the host)
- `packages/sdk` — Library-direct embedding facade (`createCatamorphic(...)`)

## Skills

- `.cursor/skills/plugin-e2e-integration/SKILL.md` — Business-agnostic end-to-end plugin integration flow (resolver, attach, secrets, sandbox, run, verification)

## Verification Checklist

After **every** change, run all applicable checks before considering it complete. Do not skip any step.

### 1. Lint

```bash
bun run lint          # from root — runs biome check on entire monorepo
bun run lint:fix      # auto-fix safe issues
```

Zero errors and zero warnings. Use `bunx biome check --write --unsafe .` for unsafe fixes, then verify.

### 2. Typecheck

```bash
turbo typecheck       # all packages from root
```

Every `.ts`/`.tsx` change must pass with zero errors.

### 3. Build

```bash
turbo build           # all packages from root
```

### 4. Tests

```bash
turbo test            # all packages from root
```

All existing tests must pass.

### 5. Browser verification (after UI/integration changes)

Catamorphic has no standalone UI. Rebuild the affected packages, refresh the `file:` links in the host app, and verify in the **host's** browser (e.g. OpenCX's workflows-v2 screen). Check: workflows render, zero browser console errors, zero Next.js dev overlay issues, no hydration mismatches.

### 6. Migration sync

```bash
bun run db:migrate && bun run db:codegen
```

### 7. Never commit

Do not run `git add`, `git commit`, or `git push` unless the user explicitly asks.

## Design Principles

Settled decisions — do not deviate without explicit user approval. Full detail in `.cursor/rules/`:

- **Project model, git versioning, templates, DB types** → `project-model.mdc`
- **Sandbox execution, Daytona, run lifecycle, instrumentation** → `sandbox-execution.mdc`
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

Define Zod schemas first, then register routes with `fastify-type-provider-zod`. After adding routes:

```bash
cd packages/server && bun run generate-spec
cd packages/api-client && bun run generate
```

### Database Changes

Forward-only raw SQL migrations in `packages/db/migrations/`. After changes:

```bash
bun run db:migrate   # apply pending migrations
bun run db:codegen   # regenerate TypeScript types
```

## Build Order

```
db → core → server → api-client
parser → core
parser → ui
core → sdk
api-client → react → ui
sandbox → core
```
