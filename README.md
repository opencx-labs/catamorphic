# Catamorphic AI

Code-first workflow builder that parses TypeScript into visual workflow graphs.

## Quick Start

```bash
# Install dependencies
bun install

# Copy and edit env (DATABASE_URL, etc.) — see .env.example
# cp .env.example .env

# Start Postgres
docker compose up -d

# Run migrations
bun run db:migrate

# Regenerate Kysely types from the database (requires DATABASE_URL in the environment)
bun run db:codegen
# If codegen cannot see your .env, pass the URL explicitly, e.g.:
# DATABASE_URL="postgresql://catamorphic:catamorphic@localhost:5432/catamorphic" bun run db:codegen

# Build shared packages the API needs so tooling can load workspace deps (dist/)
bunx turbo build --filter=@catamorphic/server...

# OpenAPI spec → api-client types (gitignored; required before @catamorphic/api-client can build)
cd packages/server && bun run generate-spec
cd ../api-client && bun run generate

# Build the whole monorepo (includes @catamorphic/ui, api-client, playground, …)
bun run build

# Start dev servers (use two terminals)
cd packages/server && bun run dev    # API on :3001
cd apps/playground && bun run dev    # UI on :3000
```

Workspace packages expose compiled `dist/` entry points. The playground imports `@catamorphic/ui` and `@catamorphic/api-client`; without a full build (and the `generate-spec` / `generate` step for the client’s OpenAPI types), Next.js can report “module not found” for those packages.

## Architecture

Workflows are TypeScript code — the source of truth. The parser converts TypeScript AST into a `WorkflowGraph`, which React Flow renders visually.

```
TypeScript Code → ts-morph Parser → WorkflowGraph → React Flow Canvas
                                                   ↕
                                              Monaco Editor
```

## Packages

| Package                   | Description                             |
| ------------------------- | --------------------------------------- |
| `@catamorphic/parser`     | ts-morph AST → WorkflowGraph parser     |
| `@catamorphic/ui`         | React Flow editor, embeddable component |
| `@catamorphic/server`     | Fastify API + Zod + OpenAPI             |
| `@catamorphic/db`         | Kysely + PostgreSQL + migrations        |
| `@catamorphic/runtime`    | Vercel Workflow SDK adapter             |
| `@catamorphic/sandbox`    | sandbox-agent wrapper for AI            |
| `@catamorphic/api-client` | Generated type-safe API client          |

## Workflow Code Format

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

## Scripts

```bash
bun run build      # Build all packages
bun run test       # Run all tests (specs)
bun run typecheck  # Typecheck all packages with tsgo
bun run lint       # Lint with Biome
bun run lint:fix   # Auto-fix lint issues
bun run db:migrate # Run database migrations
bun run db:codegen # Regenerate database types
```

## Testing (Specs)

Specs are written with **Vitest** and run through Turborepo from the root.

### Run all specs

```bash
bun run test
```

### Run specs for one workspace package

```bash
# Playground app specs
bun run --filter @catamorphic/playground test

# Parser package specs
bun run --filter @catamorphic/parser test

# Server package specs
bun run --filter @catamorphic/server test
```

### Run one spec file

```bash
cd apps/playground
bun run test src/lib/workflow-helpers.test.ts
```

### Notes

- Some integration specs (e.g. Daytona-backed tests in `packages/git` / `packages/sandbox`) require external services or network access and may fail locally without the required environment.
- Unit specs (parser/runtime/playground helpers, etc.) should run locally with no special setup.

## Tech Stack

- **Bun** — runtime, package manager, workspace
- **TypeScript** — tsgo for typechecking
- **Fastify** — API server with Zod + OpenAPI
- **React Flow** — workflow visualization
- **ts-morph** — TypeScript AST parsing
- **Kysely** — type-safe SQL query builder
- **Next.js** — playground app
- **Jotai** — state management
- **Turborepo** — build orchestration

# TODO

- Make the graph and code editor easily embeddable
  - Extract the rendering and editor logic from the playground app into an installable package
  - Should be highly configurable
    - Theme and UI
    - Toggles for minimap, code editor, AI input box, etc
- Implement Git workflow
  - Create branches for new edits, merge them to main to deploy
  - Handle versions, conflicts, sync (pull/push) in the UI
- Implement sleeps
  - Might require an abstraction that lets users return from steps - returned value is delayed and put on a queue
  - Abstraction must be minimal and must render well in the graph
- Make execution really efficient
  - Maybe run persistent server sandboxes for each project
  - Make sure managing sandboxes is simple
    - Take into account both scale-to-zero AND scale-up
