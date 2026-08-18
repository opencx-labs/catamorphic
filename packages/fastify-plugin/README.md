# @catamorphic/fastify-plugin

Mountable Fastify plugin exposing the catamorphic HTTP API (projects, workflows, runs, git ops, plugins, secrets, playground) with Zod-validated routes and a generated OpenAPI spec consumed by `@catamorphic/api-client`.

## Mount on the host's Fastify server

```ts
import { catamorphicPlugin } from "@catamorphic/fastify-plugin";

app.register(catamorphicPlugin, {
  core: catamorphic.core, // built with @catamorphic/server-sdk
  prefix: "/api",         // the generated api-client expects /api
  identity: async (request) => {
    // Who is calling — from YOUR session. See "Identity" below.
    const session = await verifySession(request);
    return session
      ? { tenantId: session.orgId, externalUserId: session.userId }
      : null;
  },
});
```

The plugin is fully encapsulated:

- Sets Zod validator/serializer compilers and an error handler for its own scope only.
- Registers **no CORS** — the host owns cross-origin policy.
- Route URLs are prefix-relative; mount anywhere, but `@catamorphic/api-client`'s generated paths assume `/api`.

## Runs

There is one Runs route family for every Workflow:

- `POST /api/projects/:projectId/workflows/:name/runs` triggers a Run of the deployed commit (async).
- `POST /api/projects/:projectId/workflows/:name/calls` calls a workflow synchronously — driven inline until it settles or reaches a durable wait; answers `completed | failed | suspended` (with `runId` to poll).
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

The plugin has exactly one identity mechanism: the required `identity`
resolver. It runs on every request and returns the caller's identity or
`null` (→ 401). There are no defaults and no headers are read unless you opt
in.

```ts
app.register(catamorphicPlugin, {
  core,
  prefix: "/api",
  identity: async (request) => {
    const session = await verifySession(request);
    if (!session) return null;
    const base = { tenantId: session.orgId, externalUserId: session.userId };
    if (session.isEmployee) return { ...base, scope: [{ kind: "project", projectId: BRAIN }] }; // builder
    return { ...base, scope: await entitlementsFor(session.userId) }; // viewer
  },
});
```

- A **root** identity (no `scope`) reaches every project and surface — a host's service calls, the desktop's own local projects.
- A **scoped** identity may reach exactly the listed artifacts — `{ kind: "project", projectId }` (a builder: the whole program surface), `{ kind: "app", projectId, name }` (the app's document plus its active version's frozen workflow set), `{ kind: "workflow", projectId, name }`, `{ kind: "agent", projectId, name, toolPolicies? }` (chat sessions on a committed project agent) or `{ kind: "document", projectId, path, access? }` (a file or `dir/**` subtree; the project store is reachable only this way) — and nothing else. Denials are a uniform 403.
- Most hosts do not hand-write scopes: commit `roles/<slug>.json` in the project and resolve members through `core.memberships.identityFor(...)` (the stock table) or `resolveRoles(core, { roles, grants })`; members with a host-issued token use `identityFromBearer(verify)`. See INTEGRATION.md "Roles as files".
- Hosts whose auth terminates in front of the plugin (gateway, proxy) can pass `identityFromHeaders()`, which reads `X-Catamorphic-Tenant-Id` and `X-External-User-Id`. Never expose such a mount to browsers directly.

## Apps

Viewer-facing app routes (`view-state`, `guest`, `storage`, `calls/:workflow`,
`runs/:workflow`, `runs/:runId`) narrow the caller to that app structurally —
the URL names it — so a builder is confined to the app while inside it and a
viewer must be entitled to it. `AppMount` in `@catamorphic/ui` uses these
routes; nothing is claimed by the client.

## Standalone app (sidecar / spec generation)

```ts
import { createApp, identityFromHeaders } from "@catamorphic/fastify-plugin";

const app = createApp({ core, identity: identityFromHeaders() });
await app.listen({ port: 8500 });
// Swagger UI at /docs, API at /api/*
```

## Regenerating the API client

After changing routes or DTOs:

```bash
bun run generate-spec            # writes packages/api-client/openapi.json
cd ../api-client && bun run generate
```
