# Desktop testing

`bun run --cwd apps/desktop test:e2e` runs all Electron suites in Docker on
a private Linux display. Your macOS keyboard, pointer, clipboard, and windows
are outside that display. The app uses normal focus, opacity, mouse handling,
and background throttling. There is no hidden/visible test split.

The first invocation builds `infra/desktop-tests/Dockerfile`. It installs
Linux dependencies from the lockfile in a separate cached layer, then builds
the desktop and its PWA guest. The source snapshot includes tracked edits and
unignored new files. It omits local environments, signing keys, dependencies,
generated output, and agent settings. Host home directories, displays, and
Docker sockets are never mounted. Each run owns its container and temp data;
cancellation removes the container. Docker's immutable layers are shared.

```sh
bun run --cwd apps/desktop test:e2e window-state
bun run --cwd apps/desktop test:e2e --shard=1/8
bun run check
```

Logs, JUnit results, and Electron screenshots are retained under
`test-results/desktop-<id>/`. The runner prints the final cached image size.
Delete old diagnostics when no longer needed. Missing Docker is an error;
the runner never falls back to Electron on the developer's desktop.

## CI

The same tests run across independent jobs:

| Lane | Runners | Isolation |
| --- | --- | --- |
| Validation | 1 Blacksmith Ubuntu, 8 vCPU | Lint, types, builds, schema sync, root tests |
| Workspace tests | Auto: 1 per 100 files, up to 16 Blacksmith Ubuntu, 8 vCPU | Vitest file shards, one disposable Postgres per job |
| PWA | 1 Blacksmith Ubuntu, 8 vCPU | Headless Chromium |
| Desktop Linux | Auto: 1 per 5 files, up to 32 Blacksmith Ubuntu, 8 vCPU | One private Xvfb + Openbox display per shard |
| Desktop macOS | Auto: 1 per 10 files, up to 16 GitHub-hosted macOS runners | One native desktop per shard |

A short planning job runs Vitest file discovery against each workspace's config
(or the shared root config) and the desktop E2E config. It does not import or
execute tests. The generated matrices grow and shrink automatically, with at
least one shard per lane. Current counts produce 4 workspace, 8 Linux desktop,
and 4 macOS desktop shards. New workspaces with a `test` script are included.

Validation and PWA start independently; sharded lanes wait only for discovery.
GitHub/account quotas may queue jobs. Runner caps bound cost; once a lane reaches
its cap, additional files increase work per shard. No extra matrix concurrency
cap is imposed. Each desktop
shard runs suites serially so apps do not compete for native focus. Vitest
shards whole files and preserves ordered tests sharing one app. Every file is
included on both operating systems. Test results are never cached. Dependency
and Turbo build caches are separated by OS, architecture, and lockfile.

The stable `checks` job requires every lane and shard to succeed. Optional
credentialed model evals remain separate and are excluded from PR checks.
Desktop logs, screenshots, and JUnit results are uploaded even after failure.

CI runs `bun scripts/desktop-test.ts --native --shard=1/8` after building.
On Linux this starts and owns a new X server; on macOS it requires a dedicated
GitHub-hosted runner. It must not run on a developer's macOS login session.
Raw harness launches reject a missing isolation context before spawning Electron.

Linux validates real Electron behavior on Linux. macOS shards retain native
window, menu, and Command-key coverage. Blacksmith macOS support exists, but
this repository uses GitHub macOS until the organization's macOS entitlement
is confirmed. See ADR 0129.

Baseline: GitHub run 34595077215 took approximately 18 minutes, including
315 seconds of visible and 380 seconds of hidden desktop tests. Measure the
new critical path and per-shard durations in CI before claiming a speedup or
adjusting the file targets and runner caps in `scripts/ci-shards.ts`. File count
is a size estimate; adding cases inside one file does not add runners. More workers on one display reduce realism;
more independent runners preserve it.
