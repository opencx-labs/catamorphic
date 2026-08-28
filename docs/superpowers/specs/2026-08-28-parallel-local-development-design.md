# Parallel Local Development Design

## Goal

Make a Catamorphic checkout a self-contained execution unit: multiple agents
can work in separate Git worktrees, run the complete local test suite against
independent infrastructure, and keep a manually running desktop plus stock
server alive without another checkout rewriting their outputs or state.

## Principles

1. A worktree is the unit of filesystem isolation. Engineering agents use a
   dedicated worktree and never run build, test, generation, or watch commands
   in a checkout occupied by another agent.
2. A test invocation owns its mutable infrastructure. Local Postgres tests run
   against a disposable PostgreSQL 17 container with an ephemeral host port.
3. A dev invocation owns its application state and ports. Desktop and stock
   server processes started together share one Turbo watch graph, while each
   worktree receives distinct desktop data, stock-server data, and listener
   ports.
4. Deterministic verification never reaches paid or shared external services.
   Daytona, S3, Cloudflare Artifacts, and Cloudflare Sandbox tests require one
   explicit external-integration opt-in.
5. Repository commands run JavaScript tooling through Bun. They do not depend
   on whichever `node` binary happens to be first on the machine's `PATH`.

## Command surface

- `bun run dev` starts the desktop and stock server through one Turbo graph.
- `bun run dev:desktop` and `bun run dev:server` use the same orchestrator for
  focused work. They are not independent hand-written Turbo graphs.
- `bun run dev:infra` owns the optional shared Postgres, ClickHouse, OTel, and
  Cloudflare bridge stack used for exploratory development.
- `bun run test` starts disposable Postgres, runs every package test with
  `DATABASE_URL` set, and always removes the container on success, failure, or
  interruption.
- `bun run test:external` is the explicit real-service suite. It is separate
  from deterministic verification and uses per-run remote identifiers.
- `bun run check` is the complete local merge gate: lint, typecheck, build,
  migration/codegen consistency, deterministic package tests, PWA E2E, and
  desktop hidden and visible E2E.

The internal commands used by orchestration are named `*:workspace` and are
not the user-facing workflow.

## Dev-instance orchestration

`scripts/dev.ts` derives a stable instance name from the absolute worktree path
unless `CATAMORPHIC_DEV_INSTANCE` overrides it. It allocates currently free
loopback ports for the stock server, operator API, and desktop CDP endpoint,
creates state under the OS temporary directory, prints the resolved resources,
then launches exactly one `turbo run dev` process with the requested app
filters. Turbo explicitly passes through every host/runtime variable used by
the desktop and stock server.

The desktop gains `CATAMORPHIC_DESKTOP_DATA_DIR`, a normal development setting
that changes Electron `userData` and the default projects directory without
turning on E2E-only behavior. Production launches without the variable retain
the existing single-instance, real-user-data behavior. Distinct dev data dirs
allow separate worktrees to run desktop instances concurrently.

The stock server always receives an explicit `CATAMORPHIC_DATA_DIR`, `PORT`,
and `CATAMORPHIC_OPERATOR_PORT` from the orchestrator. Its container default of
`/data` remains valid for `start`, but is never the implicit local-dev target.

## Test isolation

`scripts/test.ts` starts a uniquely named `postgres:17` container with a
randomly published loopback port, waits for health, builds a connection URL,
and invokes the workspace test graph. It forwards termination signals and
removes the container in `finally`. No persistent Docker volume is mounted.
Each concurrent test run therefore has its own database, `public` schema,
connection budget, and migration table.

The runner accepts injected process and Docker operations so unit tests can
exercise argument construction, health failures, child failures, and cleanup
without mocking the behavior being asserted. Concurrent-worktree verification
uses real Docker containers and real worktrees.

Real-service integration files additionally require
`CATAMORPHIC_EXTERNAL_INTEGRATIONS=1`. Remote identifiers are UUID-derived in
every suite, including Daytona storage. The ordinary test runner removes that
opt-in from its child environment even when the repository `.env` contains
credentials.

## Complete verification

`scripts/check.ts` runs the merge-gate phases sequentially inside its worktree
so generated outputs and Electron/PWA build directories are never written by
two phases at once. Separate worktrees may run the command concurrently. The
database/codegen phase uses the same disposable Postgres instance contract as
tests and fails when tracked generated database types change.

CI invokes `bun run check` instead of maintaining a second handwritten list of
verification commands. The model-in-the-loop eval remains an explicit optional
CI step because it consumes provider credentials and is not deterministic.

## Agent contract

Root `AGENTS.md`, the testing convention, and README state the operational
contract plainly:

- create or adopt an isolated worktree before engineering changes;
- install dependencies in that worktree;
- use only the public root commands;
- never copy the root `.env` wholesale into another worktree;
- use `bun run test:external` only when the task explicitly requires shared
  services;
- use `bun run check` before completion;
- do not start `dev:desktop` and `dev:server` as separate raw Turbo graphs.

## Alternatives rejected

- **One shared Postgres with per-run schemas:** lighter, but the suite tests
  `public`-schema behavior and one run can consume more than 200 configured
  pool connections. Schemas do not isolate either resource.
- **One checkout with per-command output directories:** every bundler and
  generator would need an output-root seam, and Git/checkpoint operations would
  still be shared. Worktrees solve the whole class with standard Git behavior.
- **Keep external tests credential-gated:** a developer's `.env` silently
  changes what `bun run test` means and lets parallel agents delete or exhaust
  shared resources. Explicit opt-in is predictable.

## Verification

The implementation is complete only after two temporary worktrees, driven by
separate agents, run uncached package tests concurrently while the primary
checkout remains untouched. Both runs must use different Postgres containers
and ports, complete successfully, and leave no containers or worktree-local
processes behind. A combined desktop/server dry run and a real stock-server
boot verify the dev-instance resource plan.
