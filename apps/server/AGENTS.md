# Stock server

The self-hostable Catamorphic server (ADR 0059): zero external services,
everything under one data dir: PGlite database, bare git origins,
local-process execution (the container IS the sandbox; single-tenant
ONLY, per ADR 0047), and mDNS so the LAN reaches the server. The new stock
Better Auth, OAuth, admission, and agent-driven setup path are the only remote
identity model. Do not reintroduce token files or privileged product users.

## Run

- From the repository root, `bun run dev` starts the combined desktop and
  stock-server manual environment. `bun run dev:server` is the stock-server
  focused variant of the same development orchestrator. The orchestrator
  assigns worktree-local data directories and loopback ports; do not set
  `CATAMORPHIC_DATA_DIR` manually for development.
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
- Ongoing company-brain configuration is project code: `roles/*.json`,
  `agents/*`, `.catamorphic/sidebar.js`, and
  `.catamorphic/project.json`. The stock server must not grow a parallel
  bootstrap configuration file. Role presentation targets resolved builder
  state and namespaced permissions, never hard-coded role names.

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

- `bun run test` from the repository root runs deterministic,
  Postgres-complete workspace tests, including the inject-driven loop
  (boot, project, invite, scoped chat, and revocation). Docker must be
  running so the test runner can create its disposable database.
- `bun run check` from the repository root is the merge gate. It includes
  typechecking, builds, migration and generated-type checks, deterministic
  workspace tests, and PWA and desktop E2E coverage.
- Run external integrations only with explicit authority through `bun run
  test:external`; the standard test and check commands do not contact
  credentialed external services.
