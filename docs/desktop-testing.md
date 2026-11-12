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
The container runs as the unprivileged `bun` user: on Linux the OS sandbox is
off (`--no-sandbox`), and a suite that needs Electron's sandboxed renderers
anyway (`launchApp({ sandboxedRenderers: true })`, for extension service
workers) adds `--enable-sandbox`, which Chromium refuses as root.

```sh
bun run --cwd apps/desktop test:e2e window-state
bun run --cwd apps/desktop test:e2e --shard=1/8
bun run check
```

Logs, JUnit results, and Electron screenshots are retained under
`test-results/desktop-<id>/`. The runner prints the final cached image size.
Delete old diagnostics when no longer needed. Missing Docker is an error;
the runner never falls back to Electron on the developer's desktop.

## Test process ownership

The root test and check commands give each invocation private temporary storage.
After every phase, and again before its disposable database stops, the controller
terminates the phase's process group and any detached groups with a working
directory beneath that invocation's canonical temporary root. Cancellation starts
the same bounded cleanup immediately, escalating to SIGKILL when necessary.
Native desktop CI also receives a private temporary root. Cleanup failures fail
the command and retain its files for diagnosis.

Fixtures retain each original sandbox provider through `TestSandboxes` from
`@catamorphic/sandbox/testing`, stop producers, and destroy every recorded sandbox
before deleting their directories. Teardown attempts every resource and reports
failures. The controller sweep covers worker crashes that bypass fixture hooks;
it does not change production runner reattachment or detached-command lifetime.

The sweep depends on the surviving controller and at least one group member
remaining beneath the owned root. It cannot recover ownership after every member
changes directory elsewhere, or run after the controller itself receives SIGKILL.

## Synchronizing fixtures

Wait for the state a check measures rather than a fixed startup delay. Tests of
lease deadlines and clock transitions advance a controlled clock after their
operation has started; database and worker tests still exercise real storage
and cleanup, including the capacity fence. Streaming checks use a gated fake
upstream for first-byte delivery and a controlled stream for pull backpressure,
so socket buffer sizes do not decide whether they pass.

The slow-renderer motion test holds the fake agent's answer behind a private
file gate until the renderer has sampled enough work frames. It keeps CPU
throttling and the geometry assertions, and fails after a bounded wait if the
renderer cannot produce those frames. The gate is removed on success or failure.
Fade endpoints are captured from the actual CSS animation-end event, before
React changes the text; the last animation frame before that event may have
been missed. A voice shortcut tap queues its down and up edges together, so
host round-trip latency cannot accidentally turn it into a hold.

## CI

The same tests run across independent jobs:

| Lane | Runners | Isolation |
| --- | --- | --- |
| Validation | 1 GitHub-hosted Ubuntu, 4 vCPU | Lint, types, builds, schema sync, root tests |
| Workspace tests | Auto: 1 per 100 files, up to 16 GitHub-hosted Ubuntu, 4 vCPU | Vitest file shards, one disposable Postgres per job |
| PWA | 1 GitHub-hosted Ubuntu, 4 vCPU | Headless Chromium |
| Desktop Linux | Auto: 1 per 5 files, up to 32 GitHub-hosted Ubuntu, 4 vCPU | One private Xvfb + Openbox display per shard |
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
included on both operating systems. PR CI reuses successful Turbo test tasks
when their inputs and dependency hashes match; see [test caching](test-caching.md).
Local commands, main, and manual CI runs execute tests fresh.

The stable `checks` job requires every lane and shard to succeed. Optional
credentialed model evals remain separate and are excluded from PR checks.
The live Google sign-in check (`e2e/google-sign-in.e2e.ts`) is skipped in
these lanes; `.github/workflows/google-sign-in.yml` runs it daily on macOS
and on pull requests that change what pages see of Work (ADR 0235).
Desktop logs, screenshots, and JUnit results from executed suites are uploaded
even after failure. Cache hits have a Turbo summary instead of new diagnostics.

CI runs the `catamorphic-desktop#test:e2e:ci` Turbo task. It depends on both
the desktop and mobile guest builds, then invokes
`bun scripts/desktop-test.ts --native`; `CATAMORPHIC_TEST_SHARD=1/8` selects
its Vitest file shard without changing build hashes.
On Linux this starts and owns a new X server; on macOS it requires a dedicated
GitHub-hosted runner. It must not run on a developer's macOS login session.
Raw harness launches reject a missing isolation context before spawning Electron.

Native input helpers own complete gestures. Keyboard shortcuts press and release
their modifiers, including on failure; plain pointer input clears inherited
modifier flags and pairs its press and release as one click. Suites share the
runner's pointer state, so park it away from hover targets after a native gesture
when the next app must start without a hover card.

For a race that starts immediately before a native press, use
`app.clickPointer(point, { beforePress })`. The macOS helper validates the display,
moves the pointer and reports readiness before the callback runs. A stdin handshake
then releases one press and release; callback failure cancels it without a click.
This keeps process startup outside the behavior's deadline. Record the real guest
report and trusted pointer event on the same renderer clock to verify their order.

The harness uses `devWindow('fitSize')` to fit native pointer fixtures inside
the current display's work area. Fixtures must measure the resulting viewport;
the native macOS runner can have a smaller display than the Linux runner.
Geometry tests retain `devWindow('setSize')` when they require an exact size.

Audio tests synchronize with captured samples. A held voice can show its intent
before the microphone has delivered audio, so elapsed wall time after a phase
change does not prove that the scripted speech has reached the worker.

Linux validates real Electron behavior on Linux. macOS shards retain native
window, menu, and Command-key coverage. See ADRs 0129 and 0310.

Baseline: GitHub run 34595077215 took approximately 18 minutes, including
315 seconds of visible and 380 seconds of hidden desktop tests. Measure the
new critical path and per-shard durations in CI before claiming a speedup or
adjusting the file targets and runner caps in `scripts/ci-shards.ts`. File count
is a size estimate; adding cases inside one file does not add runners. More workers on one display reduce realism;
more independent runners preserve it.


## Confined Linux source modules

The regular Docker UI suites explicitly bypass module confinement because
Docker's default masked `/proc` cannot support nested PID namespaces. That
bypass is restricted to disposable E2E profiles. The dedicated
`module-confinement-linux` CI lane sets
`CATAMORPHIC_TEST_MODULE_CONFINEMENT=1`, installs Bubblewrap and socat, and
runs both the real worker escape probes and `sidebar-live-sources.e2e.ts` in
Electron on a private display. It never reuses the host `/proc` or network.
The fixture grants a data directory so atomic file replacement has the same
behavior with Linux bind mounts and macOS Seatbelt.

On a dedicated Linux test host, give the test user an empty parent for the
synthetic private service configuration probe, then run:

```sh
sudo install -d -o "$(id -u)" -g "$(id -g)" /usr/local/etc/work-module-tests /etc/ssl/work-module-tests
CATAMORPHIC_TEST_MODULE_CONFINEMENT=1 bun run --cwd apps/desktop test src/main/module-sandbox.test.ts src/main/egress-proxy.test.ts
CATAMORPHIC_TEST_MODULE_CONFINEMENT=1 bun run --cwd apps/desktop test:e2e:ci sidebar-live-sources.e2e --bail=1
```

Ubuntu's restricted user namespaces need a scoped system Bubblewrap AppArmor
profile. Do not disable the restriction globally in product setup. Disposable
local nested-container probes may give the outer test container the mount
privileges it needs, without mounting host data, display or Docker socket;
the inner module boundary must still use fresh PID/mount/network namespaces
and the mandatory seccomp helper. A normal Docker container must fail closed.
