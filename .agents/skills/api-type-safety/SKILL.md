---
name: api-type-safety
description: Use when adding or changing Catamorphic Fastify routes, Zod request or response schemas, OpenAPI generation, generated API client types, or typed client calls.
---

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

Session notification state is part of the ordinary `AgentSessionSchema`:
`attentionRevision`, `attentionSeenRevision`, and derived
`attentionRequired`. User interaction acknowledges the current revision with
`POST /api/projects/:projectId/agent/sessions/:sessionId/attention/acknowledge`;
React clients should use `useAcknowledgeAgentSessionAttention` rather than
hand-writing a fetch.

Keep all other session lifecycle state in that same generated contract.
Session provenance is `source`; delegation uses `parentSessionId` plus the
subsession routes; navigation state is `visibility`; and durable archive uses
the archive and unarchive routes. Archive can return a typed 409
`archive_confirmation_required` payload with the exact running sessions and
counts of Watchers and processes that would be stopped. React clients should use
`useArchiveAgentSession` and `useUnarchiveAgentSession` so query invalidation
and that confirmation contract stay centralized.

`GET /api/me` is the client capability document. Its project permissions must
use the shared `PROJECT_PERMISSION_PATTERN` from `@catamorphic/core`; do not
weaken the OpenAPI response to arbitrary strings when committed role files
reject non-namespaced values. When an identity or feature field changes,
update `/me`, its route tests, the OpenAPI artifact, and consumers together.

## Key Packages

- **zod** — schema definition (single source of truth)
- **fastify-type-provider-zod** — request/response validation
- **@fastify/swagger** — OpenAPI spec generation
- **openapi-typescript** — generates `.d.ts` from spec
- **openapi-fetch** — type-safe HTTP client
