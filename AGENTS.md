# Agent Instructions

## Project Overview

Catamorphic AI is a code-first workflow builder. Workflows are TypeScript code, not JSON. The parser converts TypeScript AST into a visual graph rendered by React Flow. Non-technical users can build workflows using AI, and technical users can edit the code directly.

## Monorepo Structure

- `packages/parser` — ts-morph AST-to-WorkflowGraph parser
- `packages/ui` — React Flow editor components (embeddable)
- `packages/server` — Fastify API with Zod schemas + OpenAPI spec
- `packages/db` — Kysely instance, migrations, codegen types
- `packages/runtime` — Vercel Workflow SDK adapter
- `packages/sandbox` — sandbox-agent wrapper for AI assistance
- `packages/api-client` — Generated OpenAPI types + openapi-fetch client
- `apps/playground` — Next.js demo app

## Verification Checklist

After **every** change, run all applicable checks before considering it complete. Do not skip any step.

### 1. Lint

```bash
bun run lint          # from root — runs biome check on entire monorepo
bun run lint:fix      # auto-fix safe issues
```

Lint must pass with **zero errors and zero warnings**. The project uses Biome (config in `biome.json`). Fix all issues before moving on. If there are only unsafe auto-fixes remaining, apply them with `bunx biome check --write --unsafe .` and verify they are correct.

### 2. Typecheck

```bash
bunx tsgo --project ./tsconfig.json   # per-package
turbo typecheck                        # all packages from root
```

Every `.ts`/`.tsx` change must pass with zero errors.

### 3. Build

```bash
turbo build            # all packages from root
```

The full monorepo must build cleanly. This catches issues that typecheck alone misses (tsup bundling, Next.js compilation, etc.).

### 4. Tests

```bash
bun test                # per-package
turbo test              # all packages from root
```

All existing tests must pass. If the change touches core logic (parser, server routes, runtime), run the relevant package's tests.

### 5. Browser verification (after UI/integration changes)

After UI or integration changes, start the dev servers and visually verify in the browser:

```bash
# Terminal 1: API server
cd packages/server && bun run dev

# Terminal 2: Playground
cd apps/playground && bun run dev
```

Open `http://localhost:3000` and verify:
- All sample workflows render correctly (welcome-user, order-processing, data-pipeline)
- No errors in the browser console (open DevTools → Console)
- The Next.js dev indicator (bottom-left "N" icon) shows **zero issues**
- No React Flow warnings about edges or handles
- No hydration mismatches

### 6. Keep Next.js dev clean

The Next.js dev overlay (bottom-left indicator in dev mode) must show zero issues at all times. Common issues to watch for:
- **Hydration mismatches**: Ensure client components (`"use client"`) don't produce different HTML on server vs client. Use dynamic imports with `ssr: false` for browser-only components.
- **Console errors**: React Flow edge/handle errors, missing keys, etc. all show up in the indicator.
- **Import errors**: Ensure Node.js-only modules (ts-morph, fs, path) are never imported in client components — use Server Actions instead.

### 7. Migration sync

After any migration file change:

```bash
bun run db:migrate && bun run db:codegen
```

### 8. Never commit

Do not run `git add`, `git commit`, or `git push`. Leave all changes unstaged for the user to review and commit manually. Only create commits if the user explicitly asks.

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

All step functions take a **single destructured object parameter**. Never use positional params.

Every step function and every parameter **must** have JSDoc metadata with a `@displayname`. The UI shows these to non-technical users, so names should be human-readable and descriptive.

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

Guidelines for display names:
- **Step display names**: Short action phrases (e.g., "Send Email", "Create User", "Validate Order")
- **Parameter display names**: Descriptive labels (e.g., `orderId` → "Order ID", `emailAddress` → "Email Address", `isActive` → "Is Active"). If no `@displayname` is provided, the UI auto-generates one from the camelCase name, but an explicit one is always preferred.
- **Parameter descriptions**: Explain what the parameter does in plain language
- **Default values**: Use TypeScript default values in the destructuring pattern when a sensible default exists (e.g., `{ retries = 3 }: { retries?: number }`)
- **Types in the UI**: The UI automatically converts TypeScript types to friendly labels (`string` → "Text", `boolean` → "True or False", `number` → "Number", `string[]` → "Text List"). No special action needed.

### TypeScript Style

- Use objects as function parameters, not positional params
- Avoid `any` type
- Minimize `let` and mutable state
- Do not add obvious/narrating comments

### API Routes

Define Zod schemas first, then register routes with `fastify-type-provider-zod`. After adding routes, regenerate the OpenAPI spec:

```bash
cd packages/server && bun run generate-spec
cd packages/api-client && bun run generate
```

### Database Changes

Write forward-only raw SQL migrations in `packages/db/migrations/`. No down migrations. To undo something, write a new forward migration.

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
sandbox → playground
runtime → server
```
