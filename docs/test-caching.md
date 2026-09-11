# Test caching and selective execution

PR CI executes only deterministic test tasks whose successful result is missing
for the current inputs. Turbo traverses the existing package/task graph, hashes
each task, restores matching successes, and executes misses. It does not compare
against the previous push or mark an entire PR as tested.

For example, after a passing run, changing `packages/git` reruns that package and
its downstream consumers. Unrelated package tests reuse their results. Changing
one desktop file reruns desktop E2E on Linux and macOS: IPC, window focus, and UI
behavior require the complete app suite. A test failure is never cached, so the
same failing task remains eligible on the next push even if its files did not
change. Passing sibling tasks are saved even if their job ultimately fails.

The unit of reuse is a package test task on one shard, or one app E2E shard.
New workspace packages participate automatically through their manifests. Keep
Vitest file counts based on the whole suite so unrelated changes do not reshuffle
shards. Growing beyond a shard threshold changes the denominator and invalidates
the affected lane's test hashes; builds remain reusable.

## Inputs and boundaries

- Package source, tests, fixtures, manifests, lockfile dependencies, and transitive
  task dependencies use Turbo's native hashing.
- Shared root scripts, Vitest/TypeScript configuration, CI workflow/actions, and
  desktop container files are global inputs. Changes conservatively invalidate
  all tasks. Runtime identity includes OS/kernel, architecture, Node, Bun, runner
  image metadata when available, installed Chrome, and a digest of Linux system
  package versions (including the private display dependencies).
- Desktop E2E depends on both desktop and PWA builds. PWA E2E depends on both PWA
  and stock-server builds. Declare future fixture consumers in `turbo.json`.
- `CATAMORPHIC_TEST_SHARD` is hashed on tests and translated to Vitest flags at
  its launcher. It never changes build hashes.
- The disposable Postgres image is pinned by digest in `scripts/test-postgres.ts`,
  a hashed global input. Its random loopback port is passed through. Databases,
  temporary profiles, and external service responses are never cached.

Dependency download caches and Turbo task caches are separate. Task archives
restore from the same OS, architecture, and lane/shard across pushes, with one
immutable writer per workflow run and attempt. GitHub's PR cache scope applies;
no additional credentials or remote-cache service are needed. Before saving,
retain only hashes in the current job's Turbo summaries so archives do not grow
with every historical revision. Eviction or a cold
cache means more execution, never skipped coverage.

## Fresh verification and evidence

`bun run test`, `bun run check`, `bun run test:workspace`, and
`bun run test:external` execute tests fresh. External tests still require explicit
authorization. Main and manually dispatched CI also bypass test caches; builds
may be recomputed as part of Turbo's forced graph. The low-level Turbo command
itself supports caching, so use these public commands for local verification.

All CI lanes and the stable `checks` gate must succeed. Runner jobs still start
for hash checking even if all their tests hit the cache. Validation always runs
root orchestration tests and schema checks. CI uploads `turbo-*` JSON summaries
showing task hashes, cache status, and execution timing; logs say `cache hit` or
`cache miss`. Desktop screenshots and JUnit diagnostics exist only for suites
that actually executed. Cached success is never presented as a new native run.
