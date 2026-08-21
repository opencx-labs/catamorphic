# Stock server

The self-hostable Catamorphic server (ADR 0059): zero external services,
everything under one data dir — PGlite database, bare git origins,
local-process execution (the container IS the sandbox; single-tenant
ONLY, per ADR 0047), bearer tokens in `auth.json`, invites over an admin
API, mDNS so the LAN reaches `http://catamorphic.local:4700`.

## Run

- `bun run dev:server` (repo root) — watchers + `bun --watch src/index.ts`
  with `CATAMORPHIC_DATA_DIR` defaulting to `/data` (set it to a local
  path: `CATAMORPHIC_DATA_DIR=/tmp/cata-dev bun run dev:server`).
- Docker: see `Dockerfile` header. `--network host` for mDNS on Linux.
- Chat needs one of `ANTHROPIC_API_KEY` / `OPENROUTER_API_KEY` /
  `OPENAI_API_KEY` (`CATAMORPHIC_MODEL` overrides; anthropic defaults to
  claude-opus-5). `CATAMORPHIC_FAKE_AGENT=1` = deterministic echo agent.
- Boot prints the admin token + ready-to-paste curl for projects/invites.
  `POST /admin/invites` returns `connectLinks` for every address the
  server answers on.

## Shape rules

- The invite flow is: committed `roles/member.json` deployed to origin
  `main` (once per project) → `memberships.grant` → token in `auth.json`.
  Access is the MEMBERSHIP's; the token only names the person — revoking
  either cuts them off on the next request.
- Scoped members address the agent as `project:<projectId>:assistant`;
  the registry serves that id and the bare `assistant` (root callers).
- Never expose this server multi-tenant: local-process execution gives
  processes the host filesystem and network (ADR 0047).
- The admin surface (`/admin/*`, `/healthz`, `/`) lives OUTSIDE `/api` on
  purpose — `catamorphicPlugin` is encapsulated, so these routes carry
  their own auth (admin bearer).

## Verify

- `bun run typecheck && bun run test` — includes the full inject-driven
  loop (boot → project → invite → scoped chat → revocation).
- The cross-app proof lives in the companion:
  `cd ../companion && bun x vitest run e2e/stock-server.e2e.ts --config ./vitest.e2e.config.ts`
  boots THIS server and drives the phone UI against it.
