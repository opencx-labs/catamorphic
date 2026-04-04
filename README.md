# Catamorphic AI

Code-first workflow builder that parses TypeScript into visual workflow graphs.

## Quick Start

```bash
# Install dependencies
bun install

# Start Postgres
docker compose up -d

# Run migrations
bun run db:migrate

# Start dev servers
cd packages/server && bun run dev    # API on :3001
cd apps/playground && bun run dev    # UI on :3000
```

## Architecture

Workflows are TypeScript code — the source of truth. The parser converts TypeScript AST into a `WorkflowGraph`, which React Flow renders visually.

```
TypeScript Code → ts-morph Parser → WorkflowGraph → React Flow Canvas
                                                   ↕
                                              Monaco Editor
```

## Packages

| Package | Description |
|---------|-------------|
| `@catamorphic/parser` | ts-morph AST → WorkflowGraph parser |
| `@catamorphic/ui` | React Flow editor, embeddable component |
| `@catamorphic/server` | Fastify API + Zod + OpenAPI |
| `@catamorphic/db` | Kysely + PostgreSQL + migrations |
| `@catamorphic/runtime` | Vercel Workflow SDK adapter |
| `@catamorphic/sandbox` | sandbox-agent wrapper for AI |
| `@catamorphic/api-client` | Generated type-safe API client |

## Workflow Code Format

```typescript
/**
 * @displayname Welcome New User
 * @description Onboard a new user
 */
export async function welcomeUser({ email, name }: { email: string; name: string }) {
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
bun run test       # Run all tests
bun run typecheck  # Typecheck all packages with tsgo
bun run lint       # Lint with Biome
bun run lint:fix   # Auto-fix lint issues
bun run db:migrate # Run database migrations
bun run db:codegen # Regenerate database types
```

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
