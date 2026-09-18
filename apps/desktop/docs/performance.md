# Desktop resource verification

Run `bun run build` before measuring. From the worktree root:

```sh
bun scripts/desktop-soak.ts --duration=300 --interval=5 --output=/tmp/catamorphic-soak.json
```

The runner launches the real Electron build with isolated data and the fake agent.
It exercises repeated tab creation/close, then samples foreground, simulated
background and resumed idle. No external model or user workspace is involved.
Use `--duration=28800 --interval=30` for an overnight sample. Ctrl+C preserves
samples and runs normal app teardown.

Reports contain process-tree CPU deltas, summed RSS, process counts, and renderer
DevTools performance metrics (heap, nodes, listeners, requests and task duration
where Chromium exposes them). Summed RSS can double-count shared pages; compare
like-for-like runs, not it against an OS process's private footprint. The sampler
currently supports macOS and Linux. Its background phase emulates focus loss;
it does not simulate real OS sleep or prove native minimized-window behavior.

For sleep/wake investigations, collect a separate real-device recording including
suspend/resume timestamps. Preserve workload, build SHA, OS, interval, warmup and
baseline. Compare growth over repeated cycles and sustained idle CPU; do not claim
an overnight leak is fixed from a brief flat trace. Keep long runs outside the
normal merge gate. `e2e/runtime-idle.e2e.ts` remains the fast lifecycle regression
suite for hidden loops, browser visibility and guest cleanup.

## Development timing retention

React 19.2.8 emits User Timing measures with copied component prop details in
development. Chromium retains these under `Performance → blink::UserTiming`
until they are cleared, even without an open DevTools window. Background query
updates therefore grow the buffer throughout a long development session.
`renderer/lib/dev-performance.ts` observes delivered measures and clears names
belonging to React's Components/Scheduler tracks. It leaves application marks
and unrelated measurements alone, disconnects on HMR disposal, and is eliminated
from production builds. DevTools recordings still receive the timing events.
Recheck the track metadata and retention behavior when updating React.

Manual diagnosis on 2026-09-13 used the existing company-brain CSM profile,
Electron 43.3.0, React 19.2.8, and a single dev instance. App navigation was done
through native computer use; read-only heap profiling measured retention after
forced garbage collection. No automated application test suites were run, per
the user's manual-testing requirement.

| Snapshot (UTC) | Retained React timing measures | Renderer JS heap |
| --- | ---: | ---: |
| Before, 06:47:08 | 10,056 | 83.7 MB |
| Before, 06:48:12 | 16,797 | 84.7 MB |
| Before, 06:49:45 | 18,130 | 84.8 MB |
| After, 06:51:20 | 0 | 83.7 MB |
| After, 06:54:13 | 0 | 87.8 MB |
| After, 06:57:08 | 0 | 87.1 MB |

The after sequence included playbook and Settings navigation and performance
recording. Its final two samples had 1,601 DOM nodes, with listeners returning
from 389 to 387. A separate 25-second timing trace during manual navigation
captured 517 React profiling events with cleanup enabled. Heap bytes exclude
native allocations and other processes; these are not macOS per-app totals.
This confirms the retention fix over minutes, not an overnight soak or a full
explanation of the original system-wide memory exhaustion. DevTools snapshots
and trace processing themselves have substantial temporary memory costs.

The investigation also found that Turbo gives package tasks separate process
groups. The dev runner previously waited only for Turbo's own group and could
leave a paused Electron orphaned after stopping. `scripts/dev-runtime.ts` now
captures descendant groups before signaling, waits for all captured groups,
and escalates surviving groups after the grace period. It does not find targets
by executable name or worktree path. A fresh manual dev launch with its Electron
main process stopped via SIGSTOP was interrupted through the launcher; Electron,
helpers, and the instance lock were all gone afterwards. Diagnostic instances
were shut down after verification.

Separate follow-up: CSM app-catalog polling currently repeats a handled 403
every five seconds even when no app source is available to that member. This
produces unnecessary requests and console noise. It was observed during the
audit but is not evidence of the timing-retention fix failing.

## Palette search

The palette prepares searchable labels and keywords when its source arrays change.
Settings metadata comes from `shared/settings-catalog.ts`; typing never reads
configuration files or calls a settings API. Normal search includes settings, and
`settings` + Space or Tab selects a settings-only index. Literal matches take
priority; the existing fuzzy scorer handles abbreviations and typos when no literal
match exists. Render at most 80 results. Queries longer than 256 characters or
containing a newline bypass fuzzy search and remain available to agent/web actions.

Search remains linear in catalog size, plus sorting matches. A local Bun probe on
2026-09-09 measured 75 settings at 0.05 ms p95, and a synthetic 10,000-resource
index at 15.4 ms p95 across literal, abbreviated and missing queries (30 samples).
These are search-function timings, not Electron keystroke-to-paint latency or a
portable performance guarantee. Native tests cover the actual typing/navigation
flow. If real workspaces grow beyond this budget, measure their query distribution
before adding a worker or a more complex index.

`renderer/lib/palette-search.test.ts` covers bounded large-index results and long
input. Preserve the prepared-index boundary and result cap when adding providers.

## Changes subscriptions

[ADR 0143](../../../docs/decisions/0143-observed-git-overviews.md) replaces the
Changes section's 15-second polling with scoped main-process subscriptions.
Native filesystem events invalidate Git snapshots; Git remains authoritative.
Notifications coalesce for 200 ms with a 1-second maximum wait. A two-minute
reconciliation repairs missed events and replaced directories. Hidden windows
and collapsed sections release their subscription; returning refreshes immediately.
Identical consumers share watches, snapshots and in-flight reads. Committed diffs
are cached by HEAD and base commit IDs for the subscription's lifetime.

### Before/after measurement, 2026-09-18

Measured on an Apple M3 Pro, macOS 26.5.2, against main
`3485e4d86f369f1808ede1fff1968578532304f1`. The synthetic repository contained
21,001 tracked files and 10,000 ignored files, with one selected checkout. Both
implementations used the same fixture and Git subprocess backend. Initial warm
status reads took 130 to 164 ms. These are backend measurements, not complete
Electron process-tree CPU or keystroke-to-paint timings.

| Measurement | 15-second polling | Observed snapshots |
| --- | ---: | ---: |
| Status scans during 60 seconds of idle, after initialization | 3 | 0 |
| Process and child CPU over startup, idle and one edit | 1.70 s | 0.98 s |
| Edit 1 second after initial snapshot | 14,348 ms | 439 ms |
| Edit 7.5 seconds after initial snapshot | 7,818 ms | 556 ms |
| Edit 14 seconds after initial snapshot | 1,194 ms | 495 ms |

The CPU samples include startup and the final edit, so they do not establish an
app-wide percentage improvement. The short idle window ends before the new
two-minute reconciliation. Native watcher overhead and resource limits depend
on the OS and repository size; ignored output notifications are filtered after
delivery, not excluded from the OS watch. This is not an overnight soak.

Reproduce with `bun apps/desktop/scripts/git-overview-benchmark.mjs <fixture>
<poll|watch> [idle-seconds] [edit-delay-ms]`. The script requires a disposable
Git fixture and refuses one containing its reserved probe file. It creates only
that file, then removes it. Run each mode on the same clean synthetic repository;
use `/usr/bin/time -l` on macOS for process-plus-child CPU. `poll` isolates the old
15-second schedule using the current reader; for a historical whole-backend
comparison, set `GIT_OVERVIEW_BASELINE` to an extracted pre-change `git-view.ts`
module whose package imports resolve in the worktree. The numbers above used
the historical reader.

Tests cover external atomic saves, index changes, renames, deletes, commits,
linked checkouts and shared refs, ignored output with tracked exceptions, burst
coalescing, shared ownership, teardown races and fallback recovery. The Electron
Changes suite verifies visible writes/staging/removal without moving input focus.
