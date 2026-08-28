# 0075 - Parallel local development isolation

- **Status:** Accepted
- **Date:** 2026-08-28
- **Builds on:** 0045 and 0063

## Context

Catamorphic supports concurrent agents and explicit Git worktrees, but its own
repository commands still assumed one active checkout. Separate desktop and
stock-server dev commands launched duplicate watchers over the same `dist`
directories. Package tests could silently skip Postgres, enable shared remote
services from `.env`, or exhaust a shared database. A fresh worktree could also
invoke an unsupported system Node through tool shebangs. Running Vitest 4
through Bun's Node emulation is also incompatible with its threaded workers.

The repository is greenfield. There is no command compatibility burden, so the
developer surface should express the safe architecture directly.

## Decision

A Git worktree is the isolation boundary for engineering agents. Public root
commands own their mutable resources:

- `dev` starts desktop and stock server through one deduplicated Turbo graph,
  with worktree-scoped state and allocated ports;
- `test` provisions disposable PostgreSQL 17 on an ephemeral port and cleans
  it up after the run;
- `check` is the complete deterministic merge gate, including E2E;
- external-service integrations require a separate explicit command and
  per-run remote identifiers;
- Turbo and Vitest are invoked through a repository-pinned Node 24 binary
  rather than ambient system Node or Bun's Node emulation; Bun remains the
  package manager and application runtime.

Optional shared observability and bridge infrastructure has its own
`dev:infra` command. It is never test infrastructure. CI consumes the same
public check command as developers.

We rejected schema-only isolation because tests intentionally exercise
`public` and concurrent suites exceed one shared Postgres connection budget.
We rejected same-checkout output remapping because it would require seams in
every bundler and still leave Git and generated sources shared.

## Consequences

- Independent worktrees can build, test, and run apps concurrently without
  sharing databases, ports, app state, build output, or external resources.
- A complete test run starts a Docker container and therefore requires a
  working Docker daemon.
- External integration coverage is intentionally absent from ordinary local
  checks and remains an explicit, potentially billable operation.
- Engineering agents must use worktrees; shared-first remains appropriate for
  non-engineering Catamorphic projects but not for this repository's build
  workflow.
