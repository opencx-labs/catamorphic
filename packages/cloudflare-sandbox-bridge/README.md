# @catamorphic/cloudflare-sandbox-bridge

Thin Cloudflare Worker that exposes [Cloudflare Sandbox](https://developers.cloudflare.com/sandbox/) as an HTTP API so the host's Node/Bun process (which runs outside Workers) can create and drive sandboxes via `CloudflareSandboxProvider`.

The Worker is a small wrapper around [`@cloudflare/sandbox/bridge`](https://developers.cloudflare.com/sandbox/bridge/) — all HTTP routing, auth, and pool logic lives in that package. Bumping the Sandbox SDK is the normal way to pick up upstream changes.

See [`CLOUDFLARE.md`](../../CLOUDFLARE.md) at the repo root for architectural decisions, env vars, token provisioning, and the dev / prod runbook.

## Prerequisites

- Docker Desktop running (the Sandbox SDK uses local Docker for `wrangler dev`).
- `bun install` at the repo root.
- A Cloudflare account on the Workers Paid plan **with the Containers / Sandbox beta enabled** (needed only for `wrangler deploy`, not for local dev).

## Local dev

```sh
cp .dev.vars.example .dev.vars
bun run dev
```

This boots the Worker at `http://localhost:8787` and builds / runs the container image locally via Docker. If `SANDBOX_API_KEY` is unset the bridge skips auth (handy for local dev).

Quick smoke test once it's up (`/health` is the one route that's always open):

```sh
curl http://localhost:8787/health
# => {"ok":true}
```

Every other route requires the shared bearer, which must match `SANDBOX_API_KEY` from `.dev.vars`:

```sh
curl -H "Authorization: Bearer local-dev" http://localhost:8787/v1/openapi.html
```

Open that URL in a browser (with a bearer-injecting extension, or by calling the bridge behind Fastify) to explore all routes interactively.

## Running alongside the rest of the stack

The repo-root `bun run dev` starts this bridge alongside the playground and the docker-compose infra. To pair the bridge with a different host app, start it on its own (`bun run dev` in this package), then point the **host** at it: construct `new CloudflareSandboxProvider({ apiUrl, apiKey })` from `@catamorphic/cloudflare` in the host's boot code (typically from `CLOUDFLARE_SANDBOX_API_URL` / `CLOUDFLARE_SANDBOX_API_KEY`). See [`CLOUDFLARE.md`](../../CLOUDFLARE.md) at the repo root and `apps/playground/src/server/boot.ts` for a reference.

## Production deploy

One Worker per environment (`dev`, `staging`, `prod`). Every Fastify replica in that environment talks to the same Worker URL.

```sh
bunx wrangler login          # or: export CLOUDFLARE_API_TOKEN=...
openssl rand -hex 32 | bunx wrangler secret put SANDBOX_API_KEY
bunx wrangler deploy
```

Set the resulting URL + the same API key as `CLOUDFLARE_SANDBOX_API_URL` and `CLOUDFLARE_SANDBOX_API_KEY` on the Fastify host.

## Updating the container image

`@cloudflare/sandbox` (npm) and `docker.io/cloudflare/sandbox` (container) are released together. When bumping:

1. Update the version in `package.json`.
2. Update the `FROM docker.io/cloudflare/sandbox:<tag>` pin in `Dockerfile` to match.
3. `bun install` and `bun run dev` to verify locally.
4. `bunx wrangler deploy` per environment.

## HTTP API reference

The bridge exposes the routes documented in [Cloudflare's bridge API reference](https://developers.cloudflare.com/sandbox/bridge/http-api/):

- `POST /v1/sandbox` — allocate a sandbox ID.
- `DELETE /v1/sandbox/:id` — destroy.
- `POST /v1/sandbox/:id/exec` — run a command (SSE-streamed output).
- `PUT /v1/sandbox/:id/file/<path>` — write a file.
- `GET /v1/sandbox/:id/file/<path>` — read a file.
- `POST /v1/sandbox/:id/hydrate` — bulk-populate `/workspace` from a tar archive.
- `GET /v1/sandbox/:id/running` — liveness.

`CloudflareSandboxProvider` in [`packages/cloudflare/src/sandbox-provider.ts`](../cloudflare/src/sandbox-provider.ts) is the typed client the rest of the monorepo uses.
