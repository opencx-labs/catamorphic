# Parallel Local Development Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every Catamorphic worktree independently able to run the desktop and stock server, deterministic package tests, and the complete merge gate without sharing mutable resources with another worktree.

**Architecture:** Root Bun scripts own dev-instance planning and disposable PostgreSQL lifecycle, while Turbo remains the package graph executor. Dev processes receive worktree-scoped data directories and allocated ports through an explicit environment contract; tests receive a unique Docker Postgres URL and cannot enable external integrations accidentally. CI and agent documentation consume the same public commands.

**Tech Stack:** Bun 1.3.14, TypeScript, Turborepo 2.10, Docker/PostgreSQL 17, Vitest 4, Electron/electron-vite.

**Spec:** `docs/superpowers/specs/2026-08-28-parallel-local-development-design.md`

## Global Constraints

- Work only in an isolated Git worktree; never edit the primary checkout.
- Public commands are `dev`, `dev:desktop`, `dev:server`, `dev:infra`, `test`, `test:external`, and `check`; compatibility with their old behavior is not required.
- `dev` launches desktop and stock server in one Turbo invocation and one dependency watch graph.
- Every deterministic `test` invocation owns a disposable `postgres:17` container on an ephemeral loopback port and removes it on exit or signal.
- Deterministic tests must not contact Daytona, S3, Cloudflare Artifacts, or Cloudflare Sandbox even when `.env` contains credentials.
- External integrations require `CATAMORPHIC_EXTERNAL_INTEGRATIONS=1` and per-run remote identifiers.
- JavaScript tool CLIs must execute through Bun, not an ambient system `node` binary.
- No em dash or en dash may be added to user-facing strings or documentation.
- Do not add a runtime dependency for port allocation, hashing, process control, or Docker orchestration.
- Every production TypeScript function added by Tasks 1 and 2 must be covered by a test that was observed failing before implementation.

---

### Task 1: Worktree-scoped combined dev runner

**Files:**
- Create: `scripts/dev-plan.ts`
- Create: `scripts/dev-plan.test.ts`
- Create: `scripts/dev.ts`
- Create: `apps/desktop/src/main/development-paths.ts`
- Create: `apps/desktop/src/main/development-paths.test.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/desktop/src/main/ipc.ts`
- Modify: `apps/desktop/package.json`
- Modify: `package.json`
- Modify: `turbo.json`

**Interfaces:**
- Produces: `type DevTarget = "all" | "desktop" | "server"`.
- Produces: `sanitizeInstanceName(input: string): string`.
- Produces: `createDevPlan(input: { rootPath: string; tempPath: string; instanceOverride?: string; target: DevTarget; ports: { desktopCdp: number; server: number; operator: number } }): { instance: string; env: Record<string, string>; turboArgs: string[]; desktopDataDir: string; serverDataDir: string }`.
- Produces: `reserveLoopbackPort(): Promise<number>` in the executable module.
- Produces: `desktopDataDirFromEnvironment(env: NodeJS.ProcessEnv): string | undefined` and `defaultDesktopProjectsDir(input: { env: NodeJS.ProcessEnv; homeDir: string }): string`.
- Consumes: Turbo's existing `catamorphic-desktop#dev` dependency on the PWA bundle watcher.

- [ ] **Step 1: Write failing dev-plan tests**

  Add literal assertions that:

  - two different absolute worktree paths produce different sanitized default instance names;
  - an explicit `CATAMORPHIC_DEV_INSTANCE`-style override wins and unsafe characters become single hyphens;
  - target `all` produces one `turbo run dev --no-daemon --concurrency=64` argument list containing both `--filter=catamorphic-desktop...` and `--filter=catamorphic-server...`;
  - target `desktop` and `server` each contain only their own app filter;
  - the plan sets `CATAMORPHIC_DESKTOP_DATA_DIR`, `CATAMORPHIC_DESKTOP_CDP_PORT`, `CATAMORPHIC_DATA_DIR`, `PORT`, `CATAMORPHIC_OPERATOR_PORT`, and `CATAMORPHIC_MDNS=off` to the supplied literal paths and ports.

- [ ] **Step 2: Run dev-plan tests and verify RED**

  Run: `bun --bun vitest run scripts/dev-plan.test.ts`

  Expected: FAIL because `scripts/dev-plan.ts` does not exist.

- [ ] **Step 3: Implement the pure dev plan**

  Use `node:crypto` SHA-256 truncated to eight lowercase hex characters to distinguish identical worktree basenames. Store state under `<tempPath>/catamorphic-dev/<instance>/desktop` and `.../server`. Do not read process globals in the pure module.

- [ ] **Step 4: Run dev-plan tests and verify GREEN**

  Run: `bun --bun vitest run scripts/dev-plan.test.ts`

  Expected: all dev-plan tests pass with zero warnings.

- [ ] **Step 5: Write failing desktop path tests**

  Assert that `CATAMORPHIC_DESKTOP_DATA_DIR=/tmp/cata-a/desktop` becomes both Electron user data and `/tmp/cata-a/desktop/Catamorphic` for default projects, while an environment without the variable keeps `<homeDir>/Catamorphic`.

- [ ] **Step 6: Run desktop path tests and verify RED**

  Run: `bun --bun vitest run apps/desktop/src/main/development-paths.test.ts --config vitest.config.ts`

  Expected: FAIL because the development path module does not exist.

- [ ] **Step 7: Implement desktop path isolation**

  Call `app.setPath("userData", value)` before the single-instance lock when the development variable is set. Treat either development data or E2E data as isolated for the lock, but keep E2E-only fake, picker, and window behavior gated only by `CATAMORPHIC_E2E_DATA_DIR`. Replace `ipc.ts`'s inline default-project path with `defaultDesktopProjectsDir`.

- [ ] **Step 8: Run desktop path and existing E2E path tests**

  Run: `bun --bun vitest run apps/desktop/src/main/development-paths.test.ts apps/desktop/src/main/e2e-window-mode.test.ts --config vitest.config.ts`

  Expected: all selected tests pass.

- [ ] **Step 9: Implement the dev executable and command cleanup**

  `scripts/dev.ts` parses only `all`, `desktop`, or `server`, reserves three loopback ports, prints the instance, data directories, CDP URL, public API URL, and operator URL, then spawns `bunx turbo` with the plan arguments and inherited environment plus the plan environment. Forward `SIGINT` and `SIGTERM` to the child and exit with its status. Redefine root commands to call it; rename the old infrastructure behavior to `dev:infra`. Change the desktop package's dev command to read `CATAMORPHIC_DESKTOP_CDP_PORT`. Add explicit Turbo `passThroughEnv` entries for every desktop/server runtime variable and provider/model credential already documented by those apps.

- [ ] **Step 10: Verify the runner's public dry plan**

  Add `--print` as a no-spawn mode whose JSON is the real `createDevPlan` result after port reservation. Run:

  `bun scripts/dev.ts all --print`

  Expected: exit 0, two distinct app filters, three numeric ports, and worktree-scoped data directories.

- [ ] **Step 11: Run Task 1 checks**

  Run: `bun run lint && bun run typecheck`

  Expected: zero errors and zero warnings.

- [ ] **Step 12: Commit Task 1**

  Commit message: `feat: isolate local dev instances by worktree`

---

### Task 2: Disposable Postgres and deterministic complete tests

**Files:**
- Create: `scripts/test-postgres.ts`
- Create: `scripts/test-postgres.test.ts`
- Create: `scripts/test.ts`
- Create: `scripts/check-plan.ts`
- Create: `scripts/check-plan.test.ts`
- Create: `scripts/check.ts`
- Modify: `package.json`
- Modify: `turbo.json`
- Modify: every workspace `package.json` whose `test` script invokes `vitest` through a shebang or explicit `node`
- Modify: `vitest.config.ts`
- Modify: `packages/daytona/src/__tests__/storage-backend.integration.test.ts`
- Modify: `packages/daytona/src/__tests__/project-repo.integration.test.ts`
- Modify: `packages/daytona/src/__tests__/sandbox-provider.integration.test.ts`
- Modify: `packages/s3/src/__tests__/s3.integration.test.ts`
- Modify: `packages/cloudflare/src/__tests__/artifacts.integration.test.ts`
- Modify: `packages/cloudflare/src/__tests__/sandbox-provider.integration.test.ts`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Produces: `dockerPostgresRunArgs(input: { name: string }): string[]`.
- Produces: `parseDockerPort(output: string): number`.
- Produces: `testContainerName(input: { pid: number; nonce: string }): string`.
- Produces: `withDisposablePostgres<T>(input: { driver: TestPostgresDriver; pid: number; nonce: string; task(databaseUrl: string): Promise<T> }): Promise<T>` where the driver owns `run`, `inspectHealth`, and `stop` operations.
- Produces: `deterministicTestEnvironment(source: NodeJS.ProcessEnv, databaseUrl: string): NodeJS.ProcessEnv` with external opt-ins removed.
- Produces: `checkCommands(): readonly { label: string; command: string; args: readonly string[] }[]`.
- Consumes: Task 1's Bun-only root command convention.

- [ ] **Step 1: Write failing Postgres lifecycle tests**

  Cover these observable breaks with a small recording driver:

  - container names differ for different nonces and contain only Docker-safe lowercase characters;
  - `dockerPostgresRunArgs` publishes container port 5432 to an ephemeral IPv4 loopback port, uses `postgres:17`, configures `max_connections=300`, and mounts no volume;
  - `parseDockerPort("127.0.0.1:49175\n")` returns `49175` and rejects malformed/non-loopback output;
  - a successful task stops its container exactly once;
  - a thrown task still stops its container exactly once and rethrows the original error;
  - a startup or health failure attempts cleanup and never invokes the task;
  - deterministic environment contains the disposable `DATABASE_URL` and removes `CATAMORPHIC_EXTERNAL_INTEGRATIONS`, `CF_SANDBOX_INTEGRATION`, and all external credential variables listed in `turbo.json`.

- [ ] **Step 2: Run lifecycle tests and verify RED**

  Run: `bun --bun vitest run scripts/test-postgres.test.ts`

  Expected: FAIL because the lifecycle module does not exist.

- [ ] **Step 3: Implement disposable Postgres lifecycle**

  Use `docker run --detach --rm`, `docker port`, and `docker inspect` through an injected driver. Poll health with a bounded 60-second deadline and include container logs in the thrown startup error. Cleanup belongs in `finally`; `stop` must tolerate a container already removed by Docker. Do not create a volume or schema shared with another run.

- [ ] **Step 4: Run lifecycle tests and verify GREEN**

  Run: `bun --bun vitest run scripts/test-postgres.test.ts`

  Expected: all lifecycle tests pass.

- [ ] **Step 5: Write failing check-plan tests**

  Assert the literal phase order: lint, typecheck, build, database migration, database codegen, generated-type diff check, deterministic workspace tests, PWA E2E, desktop visible E2E, desktop hidden E2E. Assert no phase contains `test:external` or `test:eval`.

- [ ] **Step 6: Run check-plan tests and verify RED**

  Run: `bun --bun vitest run scripts/check-plan.test.ts`

  Expected: FAIL because the check plan does not exist.

- [ ] **Step 7: Implement test and check executables**

  `scripts/test.ts` owns one disposable database and runs `bunx turbo test:workspace` with deterministic environment. `scripts/check.ts` owns one disposable database across the database and package-test phases, executes the checked plan sequentially, and exits immediately on a failed phase while still cleaning Postgres. Signal forwarding must terminate the active child before cleanup.

- [ ] **Step 8: Convert all workspace Vitest scripts to Bun**

  Replace `vitest ...` and `node .../vitest.mjs ...` with `bun --bun vitest ...` or `bun --bun <absolute-workspace-relative-vitest.mjs> ...` as appropriate. Rename the Turbo task to `test:workspace`; the public root `test` command calls `scripts/test.ts`. Add `test:external` as an explicit filtered run with `CATAMORPHIC_EXTERNAL_INTEGRATIONS=1`.

- [ ] **Step 9: Gate and namespace external integrations**

  Every real-service suite requires `CATAMORPHIC_EXTERNAL_INTEGRATIONS === "1"` in addition to its credentials. Replace Daytona storage's fixed tenant/project constants with independent `crypto.randomUUID()` values and give every Daytona sandbox a run-unique label. Keep S3 and Artifacts UUID prefixes. Ordinary tests with a credentialed `.env` must report these suites skipped.

- [ ] **Step 10: Run unit tests for the orchestration**

  Run: `bun --bun vitest run scripts/dev-plan.test.ts scripts/test-postgres.test.ts scripts/check-plan.test.ts apps/desktop/src/main/development-paths.test.ts --config vitest.config.ts`

  Expected: all orchestration tests pass under Bun even when `node --version` is v20.

- [ ] **Step 11: Run a real deterministic package suite**

  Run: `bun run test`

  Expected: disposable Postgres starts, database-gated tests run rather than skip, external suites skip, all package tests pass, and the container is absent afterward.

- [ ] **Step 12: Simplify CI to the public command**

  Keep checkout, Bun/Node setup, and the Linux window manager. Replace duplicated deterministic verification steps with `bun run check`. Keep the optional local registry plus model-in-the-loop eval after it. Remove the fixed Postgres service because `check` owns its database.

- [ ] **Step 13: Run Task 2 checks**

  Run: `bun run lint && bun run typecheck && bun run build`

  Expected: zero errors and zero warnings.

- [ ] **Step 14: Commit Task 2**

  Commit message: `feat: isolate complete test runs with disposable postgres`

---

### Task 3: Future-agent and developer guidance

**Files:**
- Modify: `AGENTS.md`
- Modify: `apps/desktop/AGENTS.md`
- Modify: `apps/server/AGENTS.md`
- Modify: `.cursor/rules/testing-conventions.mdc`
- Modify: `README.md`

**Interfaces:**
- Consumes: Task 1's public dev commands and environment behavior.
- Consumes: Task 2's public test/check commands and external-integration gate.
- Produces: one authoritative workflow future agents can follow without reading implementation scripts.

- [ ] **Step 1: Update root agent instructions**

  Add a "Parallel development" section requiring engineering worktrees,
  worktree-local dependency installation, public root commands, deterministic
  tests by default, explicit external integration authority, and `bun run
  check` before completion. State that agents must never run build/test/watch
  commands in a checkout used by another active session and must never copy a
  credentialed `.env` wholesale.

- [ ] **Step 2: Replace obsolete verification and run instructions**

  Root and app instructions must describe `bun run test` as Postgres-complete,
  `bun run check` as the merge gate, `bun run dev` as the combined manual app
  environment, and `bun run dev:desktop`/`dev:server` as focused variants of
  the same orchestrator. Remove instructions that directly compose the old
  commands or require callers to choose stock server data paths manually.

- [ ] **Step 3: Update testing conventions and README**

  Document per-file temp isolation, per-invocation database isolation,
  external opt-in, worktree-local output safety, and Docker prerequisite.
  Explain `dev:infra` as optional shared observability/bridge infrastructure,
  not test infrastructure.

- [ ] **Step 4: Check documentation**

  Run: `bun run lint && rg -n 'bun run test.*everything|CATAMORPHIC_DATA_DIR=/tmp/cata-dev bun run dev:server|docker compose up -d --wait && turbo dev' README.md AGENTS.md apps/desktop/AGENTS.md apps/server/AGENTS.md .cursor/rules/testing-conventions.mdc`

  Expected: lint succeeds and the search returns no obsolete instructions.

- [ ] **Step 5: Commit Task 3**

  Commit message: `docs: teach agents the isolated development workflow`

---

### Task 4: Concurrent-worktree proof and final hardening

**Files:**
- Modify only files required by failures reproduced during this task.
- Append discovered operational constraints to the spec/ADR/docs when they
  change the durable contract.

**Interfaces:**
- Consumes: all public commands from Tasks 1 through 3.
- Produces: verification evidence from independent worktrees and agents.

- [ ] **Step 1: Create two temporary verification worktrees**

  Create two branches from the implementation branch HEAD under separate
  `/private/tmp` directories. Run `bun install --frozen-lockfile` independently
  in each. Do not copy `.env`.

- [ ] **Step 2: Dispatch two agents concurrently**

  Agent A runs `bunx turbo test:workspace --force` only through the public
  disposable-Postgres wrapper. Agent B does the same in its own worktree.
  Each records its worktree path, test container name, published port, start
  and finish time, exit status, and post-run `docker ps` cleanup check.

- [ ] **Step 3: Verify isolation evidence**

  Confirm both runs overlap in wall-clock time, use different containers and
  ports, execute database-gated tests, skip real-service integrations, and
  exit zero. Confirm neither worktree nor the primary checkout gains tracked
  or untracked generated changes.

- [ ] **Step 4: Exercise dev-instance separation**

  Run `bun scripts/dev.ts all --print` in both worktrees and confirm distinct
  instance names, state directories, and all three ports. Boot a real focused
  stock server from one worktree, wait for `/healthz`, verify its printed data
  path and endpoints, then terminate it and confirm no child process remains.

- [ ] **Step 5: Fix every reproduced issue with TDD**

  For each issue, first add the smallest failing test to the owning Task 1 or
  Task 2 test file, run it to observe the intended failure, implement the fix,
  and re-run both the focused test and the affected concurrent proof. Do not
  paper over contention by increasing timeouts.

- [ ] **Step 6: Run the complete merge gate**

  Run: `bun run check`

  Expected: lint, typecheck, build, migration/codegen consistency, package
  tests with Postgres, PWA E2E, and both desktop E2E modes all pass.

- [ ] **Step 7: Confirm cleanup and worktree integrity**

  Run `docker ps --filter label=catamorphic.test-run --format '{{.ID}}'` and
  verify it is empty. Run `git status --short` in the primary checkout and
  confirm it is unchanged from the pre-task snapshot. Remove only the two
  temporary verification worktrees after collecting evidence.

- [ ] **Step 8: Commit hardening changes if any**

  Commit message: `fix: harden parallel worktree verification`

