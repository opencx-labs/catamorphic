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
