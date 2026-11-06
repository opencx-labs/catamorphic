---
name: api-type-safety
description: Use when adding or changing Catamorphic Fastify routes, Zod request or response schemas, the generated OpenAPI spec, `@catamorphic/api-client` types, or React hooks and clients that call the API.
---

# API type safety

One pipeline, no hand-written duplicate types:

```
Zod schemas -> Fastify routes (fastify-type-provider-zod) -> OpenAPI 3.1
  -> packages/api-client/openapi.json -> openapi-typescript (src/schema.d.ts)
  -> openapi-fetch client
```

## Adding or changing a route

1. Define shared schemas in `packages/fastify-plugin/src/schemas.ts`. A schema
   used by one route file only may stay local to it (as in `routes/webhooks.ts`).
2. Add the route under `packages/fastify-plugin/src/routes/` with
   `app.withTypeProvider<ZodTypeProvider>()`, and register new route files in
   `src/plugin.ts`. URLs are prefix-relative: write `/projects/...`; the
   plugin is mounted at `/api`.
3. Enforce authorization in core services, not only in the route (ADR 0158
   permissions such as `program:write`, `sessions:read`).
4. Regenerate from the worktree root and commit both generated files:

   ```bash
   (cd packages/fastify-plugin && bun run generate-spec)
   (cd packages/api-client && bun run generate)
   ```

   `bun run check` does not diff these artifacts, so a stale spec only shows up
   as wrong client types later.
5. Add or update the route test in `packages/fastify-plugin/src/__tests__/`.

Clients get full inference from generated paths, which include `/api`:

```typescript
import { createApiClient } from "@catamorphic/api-client";

const client = createApiClient({ baseUrl, fetch: authedFetch });
const { data, error } = await client.GET("/api/projects/{projectId}", {
  params: { path: { projectId } },
});
```

## Contracts to keep in the generated schema

- **Session state** lives in `AgentSessionSchema`: `source`,
  `parentSessionId` (delegation, with the subsession routes), `visibility`,
  and `attentionRevision` / `attentionSeenRevision` / `attentionRequired`.
  Do not add parallel session state elsewhere.
- **Archive** can return a typed 409 `archive_confirmation_required` listing
  the running sessions, Watchers, and processes that would stop. React hosts use
  `useArchiveAgentSession`, `useUnarchiveAgentSession`, and
  `useAcknowledgeAgentSessionAttention` from `@catamorphic/react` instead of
  hand-written fetches.
- **`GET /api/me`** is the client capability document. Its permissions use
  `PROJECT_PERMISSION_PATTERN` from `@catamorphic/core`; do not widen them to
  arbitrary strings. When an identity or feature field changes, update `/me`,
  its route test, the OpenAPI artifact, and consumers together.
