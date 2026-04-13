# Agent Instructions

## Project Overview

Catamorphic AI is a code-first workflow builder. Workflows are TypeScript code, not JSON. The parser converts TypeScript AST into a visual graph rendered by React Flow. Non-technical users can build workflows using AI, and technical users can edit the code directly.

## Monorepo Structure

- `packages/parser` — ts-morph AST-to-WorkflowGraph parser
- `packages/ui` — React Flow editor components (embeddable)
- `packages/server` — Fastify API with Zod schemas + OpenAPI spec
- `packages/db` — Kysely instance, migrations, codegen types
- `packages/runtime` — Workflow execution harness (runs inside sandbox)
- `packages/sandbox` — Daytona sandbox provider + coding agent (Codex SDK)
- `packages/api-client` — Generated OpenAPI types + openapi-fetch client
- `apps/playground` — Next.js demo app

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

```bash
cd packages/server && bun run dev    # Terminal 1
cd apps/playground && bun run dev    # Terminal 2
```

Open `http://localhost:3000`. Check: workflows render, zero browser console errors, zero Next.js dev overlay issues, no hydration mismatches.

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
- **Playground UI: history sidebar, run panel, state management** → `playground-ui.mdc`
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
db → server → api-client
parser → server
parser → ui
api-client → ui → playground
sandbox → server → playground
```
