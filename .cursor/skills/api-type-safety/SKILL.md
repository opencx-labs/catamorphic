# API Type Safety Pipeline

## Overview

End-to-end type safety from server to client with zero manual type duplication.

## Pipeline

```
Zod Schemas → Fastify Routes → OpenAPI 3.1 Spec → openapi-typescript → openapi-fetch Client
```

## Adding a New API Route

1. Define Zod schemas in `packages/fastify-plugin/src/schemas.ts`
2. Register the route in the appropriate file under `packages/fastify-plugin/src/routes/` — route URLs are **prefix-relative** (write `/projects`, not `/api/projects`; the plugin is mounted with `prefix: "/api"`)
3. Regenerate the OpenAPI spec and client types:

```bash
cd packages/fastify-plugin && bun run generate-spec
cd packages/api-client && bun run generate
```

4. The client automatically gets full type inference (generated paths include the `/api` prefix):

```typescript
const { data, error } = await client.GET("/api/projects/{projectId}", {
  params: { path: { projectId: "abc" } },
});
// data is fully typed
```

## Key Packages

- **zod** — schema definition (single source of truth)
- **fastify-type-provider-zod** — request/response validation
- **@fastify/swagger** — OpenAPI spec generation
- **openapi-typescript** — generates `.d.ts` from spec
- **openapi-fetch** — type-safe HTTP client
