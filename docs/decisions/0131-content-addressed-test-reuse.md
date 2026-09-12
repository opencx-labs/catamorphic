# 0131 - Content-addressed test reuse

- **Status:** Accepted
- **Date:** 2026-09-11

## Context

Repeated PR pushes rerun passing tests even when their inputs are unchanged.
The user requested selective execution through downstream consumers and reuse
of previous successes. ADR 0129 deliberately disabled test-result caching.

## Decision

Use Turbo's existing content hashes and task graph to select execution. Cache
successful deterministic workspace and E2E tasks in PR CI. A package change
invalidates its own build/tests and transitive consumers. Declare non-import
consumers as task dependencies: desktop E2E consumes the PWA build; PWA E2E
consumes the stock-server build. Keep whole-package and whole-file coverage.

Hash shared scripts, test and TypeScript configuration, CI setup, the pinned
Postgres image, platform/runtime identity, and test-only shard identity. Pass
the disposable database address through without hashing its random port.
Never cache database state. Local verification, external integrations, main,
and manually dispatched CI execute tests fresh.

Restore and save GitHub Actions task caches per OS, architecture, and stable
lane/shard. Save successful entries even when a sibling task fails; Turbo never
stores failed tasks. Dependency downloads have their own cache. Each job writes
an immutable run/attempt key, with same-lane fallback across PR pushes. Upload
Turbo summaries to distinguish reused results from executed tests and prune
obsolete hashes before archiving the current job's graph.

Git-diff-only selection was rejected: a diff against the previous push can omit
unchanged failures, and a second graph would have to duplicate runtime fixture
relationships. Cache misses always execute, so eviction cannot lose coverage.
This supersedes only ADR 0129's prohibition on caching successful tests.

## Consequences

New packages and dependency edges participate automatically. Cold caches, shared
infrastructure changes, and shard-count changes do more work. Jobs still start
to restore and check hashes; they do not launch tests on cache hits. No remote
cache service or custom test dependency database is required. Cache accuracy
requires declaring new fixture inputs and task dependencies. Main provides a
fresh full-suite check of runner behavior and nondeterminism after every merge.
