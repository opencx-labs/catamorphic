# Stock server

The self-hostable Catamorphic server (ADR 0059): zero external services,
everything under one data dir: PGlite database, bare git origins,
local-process execution (the container IS the sandbox; single-tenant
ONLY, per ADR 0047), and mDNS so the LAN reaches the server. The new stock
Better Auth, OAuth, admission, and agent-driven setup path are the only remote
identity model. Do not reintroduce token files or privileged product users.

## Run

- `bun run dev:server` (repo root) — watchers + `bun --watch src/index.ts`
  with `CATAMORPHIC_DATA_DIR` defaulting to `/data` (set it to a local
  path: `CATAMORPHIC_DATA_DIR=/tmp/cata-dev bun run dev:server`).
- Docker: see `Dockerfile` header. `--network host` for mDNS on Linux.
- Chat needs one of `ANTHROPIC_API_KEY` / `OPENROUTER_API_KEY` /
  `OPENAI_API_KEY` (`CATAMORPHIC_MODEL` overrides; anthropic defaults to
  claude-opus-5). `CATAMORPHIC_FAKE_AGENT=1` = deterministic echo agent.
- Boot prints public API, documentation, and sign-in locations, never a
  credential.
- Local setup agents inspect the schemas under `src/setup` and call the
  `/_catamorphic/operator/*` operations on the dedicated loopback-only setup
  listener (port 4701 by default) using the owner-only machine credential
  under the data directory. These operations bootstrap explicit
  roles, admission, and ordinary Better Auth users. They are not a human CLI,
  product UI, user role, or server-owner identity.
- Project managers use their ordinary OAuth identity and committed
  `memberships:manage` or `roles:manage` permissions for admission and
  membership APIs under `/api/projects/:projectId`.

## Shape rules

- An invitation is a credential-free project admission locator. The recipient
  signs in through OAuth with PKCE, redeems the invitation, and receives access
  only through the resulting membership. Access tokens identify the person and
  do not carry roles.
- Scoped members address the agent as `project:<projectId>:assistant`;
  the registry serves that id and the bare `assistant` (root callers).
- Never expose this server multi-tenant: local-process execution gives
  processes the host filesystem and network (ADR 0047).
- `/_catamorphic/operator/*` is machine-local setup authority on a separate
  Fastify listener bound to `127.0.0.1`. Never register those routes on the
  public app or expose the setup port from the container. `/healthz` and the
  hosted PWA are public. Application administration belongs under `/api` and
  uses ordinary project permissions.

## Verify

- `bun run typecheck && bun run test` — includes the full inject-driven
  loop (boot → project → invite → scoped chat → revocation).
- The cross-app proof lives in the pwa:
  `cd ../pwa && bun x vitest run e2e/stock-server.e2e.ts --config ./vitest.e2e.config.ts`
  boots THIS server and drives the phone UI against it.
