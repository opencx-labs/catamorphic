# @catamorphic/fastify-plugin

Mountable Fastify plugin exposing the catamorphic HTTP API (projects, workflows, runs, git ops, plugins, secrets, playground, templates) with Zod-validated routes and a generated OpenAPI spec consumed by `@catamorphic/api-client`.

## Mount on the host's Fastify server

```ts
import { catamorphicPlugin } from "@catamorphic/fastify-plugin";

app.register(catamorphicPlugin, {
  core: catamorphic.core, // built with @catamorphic/server-sdk
  prefix: "/api",         // the generated api-client expects /api
});
```

The plugin is fully encapsulated:

- Sets Zod validator/serializer compilers and an error handler for its own scope only.
- Registers **no CORS** — the host owns cross-origin policy.
- Route URLs are prefix-relative; mount anywhere, but `@catamorphic/api-client`'s generated paths assume `/api`.

## Runs

There is one Runs route family for every Workflow:

- `POST /api/projects/:projectId/workflows/:name/runs` triggers a Run of the deployed commit.
- `GET /api/projects/:projectId/workflows/:name/runs` lists Runs.
- `GET /api/runs/:runId` and `/api/runs/:runId/*` expose detail and capability-driven controls.

Boundaries, batch scopes, pauses, and item progress are capabilities/details on
the canonical Workflow and Run models. They do not get separate route families.
Run list and detail responses expose every Batch processing scope as ordered
`batchScopes`, including failed and canceled attempts, so hosts can inspect
items by `workflowStepAttemptId` after the Run is terminal.
Pause and resume return `409` when their current Run capability is unavailable;
repeating an operation after it already reached its target paused/running state
is idempotent.

Workflow list and detail routes accept `?ref=<git-ref>`. Workflow detail always
includes `projectFiles` and `allFiles`; public workflow responses omit internal
parser execution descriptors.

## Identity

Every request requires two headers (no defaults):

- `X-Catamorphic-Tenant-Id` — host org id
- `X-External-User-Id` — host user id

Set them **server-side from the host's verified auth context** (session/JWT). Never forward browser-supplied values unchecked.

## Standalone app (sidecar / spec generation)

```ts
import { createApp } from "@catamorphic/fastify-plugin";

const app = createApp({ core });
await app.listen({ port: 8500 });
// Swagger UI at /docs, API at /api/*
```

## Regenerating the API client

After changing routes or DTOs:

```bash
bun run generate-spec            # writes packages/api-client/openapi.json
cd ../api-client && bun run generate
```
