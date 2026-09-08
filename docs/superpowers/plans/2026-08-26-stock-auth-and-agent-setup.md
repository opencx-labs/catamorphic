# Stock Authentication and Agent-Driven Setup Plan

> **For agentic workers:** Use `superpowers:test-driven-development` while
> implementing each behavior and `superpowers:verification-before-completion`
> before reporting the slice complete. This plan is executed inline in the
> current task; do not create subagents.

**Goal:** Establish the stock server's Better Auth foundation and make both
stock setup and custom-host embedding discoverable and adaptive for coding
agents, without exposing a second remote connection path before OAuth cutover.

**Architecture:** Better Auth is a stock-host detail behind a small
`StockAuth` interface. Local PGlite uses a separate auth database under the
server data directory so Catamorphic's schema and long-lived PGlite session
remain isolated; `DATABASE_URL` uses a dedicated `catamorphic_auth` schema in
the same Postgres. A deterministic agent operation creates a Better Auth user
through the server API and assigns ordinary project roles through Catamorphic
services. The public setup skill first inspects an existing application and
routes to stock-host or custom-host references instead of prescribing a fixed
stack.

**Cutover boundary:** The existing `auth.json` remote connection flow remains
untouched and unextended during this foundation slice. Better Auth is not
mounted as a second public sign-in path yet. The next OAuth/admission slice
mounts the new routes, changes HTTP identity resolution, and atomically deletes
`AuthStore`, token connect links, printed admin credentials, and admin-token
routes.

**Tech Stack:** TypeScript, Bun, Better Auth 1.6, Kysely, PGlite, `pg`,
Fastify, Vitest, Agent Skills.

**Design:**
`docs/superpowers/specs/2026-08-26-remote-server-auth-and-connection-design.md`

## Implementation status

Implemented on 2026-08-26. Focused stock-server tests pass, including PGlite,
Postgres, restart persistence, and a disposable Docker provisioning run. Root
typecheck and build pass. Root lint exits successfully with one pre-existing
warning in an ignored `.superpowers` worktree. The full root test command is
not safe to run outside the sandbox because the working environment contains
live Cloudflare credentials, while its sandboxed run reaches an existing
Cloudflare integration suite and fails on blocked DNS. The local-only stock
server suite passes outside the sandbox. No commit was made.

## Completed feasibility gate

- [x] Install Better Auth, PGlite, Kysely, and `pg` in an isolated temporary
      directory without touching repository dependencies.
- [x] Run Better Auth's programmatic migrations against PGlite.
- [x] Create a local username user with `auth.api.signUpEmail` and authenticate
      it with `auth.api.signInUsername` against PGlite.
- [x] Repeat migration, user creation, and authentication against the
      repository's regular Postgres container in an isolated schema.
- [x] Confirm the created and signed-in user ids match and a session token is
      returned on both backends.

## Task 1: Record the architecture and install only stock-host dependencies

**Files:**

- Create: `docs/decisions/0071-stock-auth-and-agent-driven-setup.md`
- Modify: `docs/decisions/README.md`
- Modify: `apps/server/package.json`
- Modify: `bun.lock`

- [ ] Write ADR 0071 with these accepted decisions: framework identity stays
      host-injected; Better Auth belongs only to `apps/server`; local auth is
      an operator-selected fallback; no owner/admin user; setup is agent
      driven; PGlite auth data is isolated under `<data>/auth-db`; network
      Postgres auth tables use `catamorphic_auth`; provisioning calls auth and
      membership services rather than writing rows.
- [ ] Add direct runtime dependencies `better-auth`, `pg`, and the matching
      `@types/pg` development dependency to `apps/server` using Bun so the
      lockfile is canonical.
- [ ] Run `bun install --frozen-lockfile` after the dependency edit to prove
      the checked-in graph resolves.

## Task 2: Build the stock auth database lifecycle test-first

**Files:**

- Create: `apps/server/src/auth/auth-database.ts`
- Create: `apps/server/src/auth/auth-database.test.ts`

- [ ] Write a failing PGlite test that opens a temporary stock auth database,
      runs Better Auth migrations twice, and closes cleanly.
- [ ] Implement `openStockAuthDatabase({ dataDir, databaseUrl? })` returning a
      Better Auth-compatible database input plus an idempotent `migrate()` and
      `close()`.
- [ ] For local mode open a dedicated PGlite at `<dataDir>/auth-db`. Do not
      change the Catamorphic database's shared PGlite `search_path`.
- [ ] For Postgres create `catamorphic_auth` with a narrowly owned pool whose
      connections set `search_path=catamorphic_auth,public`; quote the schema
      as an identifier and never interpolate user input.
- [ ] Write a Postgres test behind the repository's standard database test
      helper or `DATABASE_URL`; require the same twice-migrate behavior and
      isolate cleanup to this test's schema strategy.
- [ ] Run the focused auth-database tests in red-green-refactor order.

## Task 3: Build the stock Better Auth host test-first

**Files:**

- Create: `apps/server/src/auth/stock-auth.ts`
- Create: `apps/server/src/auth/stock-auth.test.ts`

- [ ] Write failing tests for `createStockAuth({ database, baseURL, secret })`:
      local username/password enabled, public email signup disabled, username
      immutable, a server-side create call succeeds, username sign-in returns
      a session, and session resolution returns the same user id.
- [ ] Configure Better Auth with the username and bearer/session plugins only
      in this slice. Do not add the admin plugin or encode Catamorphic roles in
      Better Auth.
- [ ] Expose the smallest host-owned interface needed by the server:
      `createLocalUser`, `signInUsername` for tests, `resolveSession`,
      `handler` for the later cutover, `migrate`, and `close`.
- [ ] Use `<username>@local.invalid` only as Better Auth's internal required
      email when the operator did not supply an email. It must not appear as a
      claim that the address is deliverable.
- [ ] Persist or inject the Better Auth signing secret through a stock-host
      helper with owner-only file permissions. Never log it. Add tests proving
      restart reuse and permissions.
- [ ] Keep external OAuth/provider configuration injectable so the next slice
      can add providers without branching the Catamorphic identity resolver.
- [ ] Run the focused stock-auth tests.

## Task 4: Add a deliberately small agent provisioning operation

**Files:**

- Create: `apps/server/src/setup/provision.ts`
- Create: `apps/server/src/setup/provision.test.ts`
- Create: `apps/server/scripts/provision.ts`
- Modify: `apps/server/package.json`
- Modify: `apps/server/Dockerfile`

- [ ] Write a failing test that provisions a local username user with one
      Better Auth API call and returns its stable Better Auth user id.
- [ ] Write a failing test that grants that user an existing committed role in
      an existing project through `core.memberships.grant`, then resolves the
      same user through `core.memberships.identityFor`.
- [ ] Implement one keyed library operation whose inputs are user details and
      optional membership assignments. It may create the auth user and call
      membership services; it must not hash passwords, construct auth rows,
      invent server-owner state, or hide role-file creation.
- [ ] Keep project and role creation explicit. If a requested role file does
      not exist, return an actionable error that tells the setup agent to add
      the committed role definition, rather than silently inventing policy.
- [ ] Add a thin Bun runner that reads exactly one JSON document from stdin and
      invokes the library operation. Passwords are never accepted in command
      arguments and output never echoes them. This is an agent operation, not
      a user-facing CLI: no command tree, interactive prompts, or admin shell.
- [ ] Ensure the existing `COPY . .` image build includes the runner and add a
      stable package script an agent can invoke from source or with
      `docker exec -i`.
- [ ] Add a subprocess test proving stdin succeeds, malformed input fails
      clearly, and output contains no submitted secret.
- [ ] If this operation grows beyond the auth call, role validation, and
      membership calls described here, stop and remove built-in local
      provisioning instead of building an account-management system.

## Task 5: Replace the public embedding skill with one adaptive setup entry

**Files:**

- Create: `skills/setup-catamorphic-server/SKILL.md`
- Create: `skills/setup-catamorphic-server/references/stock-server.md`
- Create: `skills/setup-catamorphic-server/references/custom-host.md`
- Create: `skills/setup-catamorphic-server/references/auth-and-identity.md`
- Create: `skills/setup-catamorphic-server/references/database-and-migrations.md`
- Delete: `skills/embed-catamorphic/SKILL.md`
- Modify: `AGENTS.md`
- Modify: `README.md`
- Modify: `INTEGRATION.md`
- Modify: `site/llms.txt`
- Modify: `site/agents/index.html`
- Modify: `apps/server/AGENTS.md`
- Modify: `apps/server/README.md`

- [ ] Write the skill entry so the first action is inspection: repository
      shape, existing framework/app, auth middleware and session model,
      database, deployment, code host, storage, and execution constraints.
- [ ] Tell the agent to ask only questions that remain unanswered by visible
      setup. In particular, ask whether to preserve/adapt existing auth or
      configure a provider before offering stock local credentials.
- [ ] Route stock installation, custom-host embedding, auth mapping, and
      database maintenance into focused references. Guidance describes
      contracts, checks, and canonical code pointers; it does not insist on a
      package manager, deployment shape, or one auth implementation.
- [ ] Preserve the useful capability guidance from the old embedding skill in
      the custom-host reference or canonical links. Remove stale claims that
      there is no stock server and all token-file instructions.
- [ ] Include source and container examples for the same stdin provisioning
      operation, plus backup/migration verification for PGlite and Postgres.
- [ ] State plainly that custom hosts should adapt their existing auth and map
      verified host identity per request. They do not need Better Auth.
- [ ] Update every in-repo and website discovery pointer to the new single
      skill. Do not retain an alias or compatibility copy.
- [ ] Verify the skill against three written scenarios: existing SaaS with
      auth, stock Docker with Google/OIDC desired, and stock Docker choosing
      local credentials. Confirm it asks only unresolved questions and offers
      alternatives rather than a rigid recipe.

## Task 6: Integrate the foundation without exposing a second connection path

**Files:**

- Modify: `apps/server/src/server.ts`
- Modify: `apps/server/src/server.test.ts`
- Modify: `apps/server/src/index.ts`

- [ ] Construct and migrate `StockAuth` during stock-server boot, expose it to
      the agent provisioning operation, and close it during shutdown.
- [ ] Add a test proving restart persists a provisioned user on PGlite.
- [ ] Do not mount Better Auth HTTP routes or change API identity resolution in
      this slice. Existing remote tests must remain unchanged and green until
      the atomic OAuth/admission cutover.
- [ ] Do not print the Better Auth secret or local user credentials at boot.
- [ ] Update internal comments so the temporary cutover boundary is explicit
      and cannot be mistaken for the final architecture.

## Task 7: Verify the slice

- [ ] Run focused server auth, provisioning, and stock-server tests.
- [ ] Run `bun run lint` and require zero warnings and errors.
- [ ] Run `bun run typecheck` and require all packages to pass.
- [ ] Run `bun run build` and require all packages to pass.
- [ ] Run `bun run test` and require all suites to pass.
- [ ] Build the stock Docker image and run the stdin provisioning operation
      against a mounted PGlite volume. Restart and authenticate the same user
      through the library test harness.
- [ ] Run the Postgres auth integration test against the repository's dev
      Postgres.
- [ ] Run `git diff --check` and inspect `git status --short`, preserving all
      unrelated user changes.
- [ ] Do not commit. The user must explicitly request any new commit.

## Handoff to the next slice

Write `2026-08-26-remote-oauth-and-admission.md` against the interfaces that
actually landed. That plan must mount Better Auth/OAuth, implement admission
and ordinary role-management authorization, convert all clients, and only
then delete `AuthStore`, `auth.json`, token-bearing links, printed admin
tokens, and `/admin/*` token authorization in one greenfield cutover.

## Skill evaluation record

Baseline evaluations without the new skill exposed three concrete failures:

- the stock Google Workspace case declared provider auth unsupported and
  redirected the user to the legacy token-file invite flow;
- the stock local case invented an invite payload, reused a printed admin
  token, and never created an authenticatable local user;
- the existing SaaS case preserved auth but over-selected infrastructure and
  described the Fastify identity boundary imprecisely.

After the adaptive skill and routed references were present, the same cases
preserved existing Better Auth, separated login from project membership,
refused to invent version-specific provider configuration, selected the
maintained stdin operation for local provisioning, and treated the machine
credential as operational authority rather than a user. The skill also passes
the canonical `skill-creator` validation script.
