# Catamorphic AI

Code-first workflow builder that parses TypeScript into visual workflow graphs.

> **Embed-only project.** Catamorphic ships as a set of libraries that a host application (for example OpenCX) mounts in-process. It does not run as a standalone product — there is no dev server, demo app, or default identity. The host app provides auth, the user/org model, the database (or schema), and the deployment surface. See [`INTEGRATION.md`](INTEGRATION.md) for the host integration flow and [`AGENTS.md`](AGENTS.md) for agent guidance.
>
> **Embedding shortcut:** `@catamorphic/sdk` — host imports `createCatamorphic(...)` and calls `cat.forTenant(orgId).forUser(userId).projects.create(...)` in-process, no sidecar HTTP server required. See [`packages/sdk/README.md`](packages/sdk/README.md). When the host needs a network boundary or isn't Node/Bun, mount `@catamorphic/server`'s `createApp({ core })` as an in-process (or sidecar) Fastify app and talk to it through `@catamorphic/api-client`.

## Quick Start (local development against a host app)

```bash
# Install dependencies (workspaces only contains packages/*)
bun install

# Start a local Postgres for schema iteration + tests
docker compose up -d

# Point catamorphic migrations at a database. When the host already owns a
# Postgres (e.g. opencx), re-use it and scope catamorphic to its own schema.
DATABASE_URL="postgresql://catamorphic:catamorphic@localhost:5432/catamorphic" \
CATAMORPHIC_DB_SCHEMA=catamorphic \
bun run db:migrate

# Regenerate Kysely types from the database. The script is scoped to the
# `catamorphic` schema, so it's safe to point at a host DB.
DATABASE_URL="postgresql://catamorphic:catamorphic@localhost:5432/catamorphic" \
bun run db:codegen

# Build the monorepo so workspace consumers can resolve dist/ entry points.
bun run build

# Regenerate the OpenAPI spec + the typed api-client whenever server routes
# or DTOs change.
cd packages/server && bun run generate-spec
cd ../api-client && bun run generate
```

To iterate on catamorphic alongside a host app, install the packages the host
needs via `file:` links (see `INTEGRATION.md` → "Local dev linking"). There is
no root `bun run dev` — you run the **host app**, which boots catamorphic
in-process.

## Architecture

Workflows are TypeScript code — the source of truth. The parser converts TypeScript AST into a `WorkflowGraph`, which React Flow renders visually.

```
TypeScript Code → ts-morph Parser → WorkflowGraph → React Flow Canvas
                                                   ↕
                                              Monaco Editor
```

## Packages

| Package                   | Description                                                             |
| ------------------------- | ----------------------------------------------------------------------- |
| `@catamorphic/parser`     | ts-morph AST → WorkflowGraph parser                                     |
| `@catamorphic/react`      | Headless React bindings (provider + hooks + atoms)                      |
| `@catamorphic/ui`         | React Flow editor, embeddable component                                 |
| `@catamorphic/core`       | Framework-free service layer (projects/workflows/runs)                  |
| `@catamorphic/sdk`        | Library-direct embedding facade (scoped client)                         |
| `@catamorphic/server`     | Fastify app factory (`createApp({ core })`) — mount in-process or as sidecar |
| `@catamorphic/db`         | Kysely + PostgreSQL + migrations                                        |
| `@catamorphic/runtime`    | Vercel Workflow SDK adapter                                             |
| `@catamorphic/sandbox`    | sandbox-agent wrapper for AI                                            |
| `@catamorphic/plugins`    | Host-attached package / secret resolver for workflow runtime            |
| `@catamorphic/api-client` | Generated type-safe API client                                          |
| `@catamorphic/registry`   | shadcn-style copy-paste component registry                              |

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
bun run db:migrate # Apply migrations to the DB pointed at by DATABASE_URL
bun run db:codegen # Regenerate Kysely types from the `catamorphic` schema
bun run db:reset   # Drop + recreate the catamorphic schema (dev only)
bun run db:status  # Show applied / pending migrations
```

## Testing (Specs)

Specs are written with **Vitest** and run through Turborepo from the root.

### Run all specs

```bash
bun run test
```

### Run specs for one workspace package

```bash
# Parser package specs
bun run --filter @catamorphic/parser test

# Server package specs
bun run --filter @catamorphic/server test
```

### Run one spec file

```bash
cd packages/parser
bun run test src/__tests__/parser.test.ts
```

### Notes

- Some integration specs (e.g. Daytona-backed tests in `packages/git` / `packages/sandbox`) require external services or network access and may fail locally without the required environment.
- Unit specs (parser/runtime/server route validation, etc.) should run locally with no special setup.

## Tech Stack

- **Bun** — runtime, package manager, workspace
- **TypeScript** — tsgo for typechecking
- **Fastify** — API surface with Zod + OpenAPI (mounted by the host)
- **React Flow** — workflow visualization
- **ts-morph** — TypeScript AST parsing
- **Kysely** — type-safe SQL query builder
- **Jotai** — state management
- **Turborepo** — build orchestration

# TODO

- Make the graph and code editor easily embeddable
  - Extract the rendering and editor logic into an installable package
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
