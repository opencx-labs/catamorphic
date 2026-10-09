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

## Web page loading and sleeping tabs

ADR 0194 records the measurements. Three rules keep pages loading as they
do in Chrome:

- **Keep requests off the main process.** An Electron `webRequest`
  listener runs every request it matches through the main event loop,
  which the embedded server shares; a busy main thread then delays the
  page. Filter listeners by resource type (`types`), which Chromium applies
  before the hop. A URL filter does not avoid it. The `Sec-CH-UA` rewrite
  matches documents and fetch/XHR only.
- **No global V8 flags.** `js-flags` set at runtime reach every renderer,
  including every web page, and not the main process.
- **Unused tabs sleep.** `renderer/lib/tab-sleep.ts` unloads browser tabs
  out of sight for the profile's `browserTabSleep` time and mounts a
  restored workspace's hidden tabs asleep; `main/browser-sleep.ts` keeps
  their page state and decides what keeps a page awake. Test runs shorten
  the minute with `CATAMORPHIC_E2E_TAB_SLEEP_MINUTE_MS`
  (`e2e/browser-sleep.e2e.ts`).

To compare page loads, serve a page with many subresources from a local
server with fixed latency and load it in a plain Electron window with and
without the change, cold (a new partition) and warm, while blocking the
main thread on a schedule. Internet sites vary too much between runs.

## Sidebar motion over heavy content

A sidebar that animates its width changes the content area's size on every
frame. A web page renders in its own process and the embedder waits for it
on each resize; a terminal refits and Monaco relayouts. With a GitHub tab
showing, a width-animated Cmd+B toggle ran 4–7 frames of 40–55 ms (a
terminal: 6 of 53–67 ms) while the renderer's main thread was nearly idle.

Sidebars therefore move first and the content settles after them
(`lib/sidebar-motion.ts`, ADR 0200). The panel slides with a transform
over the content when opening and away from it when closing (closing from
open, 100 ms after its items start to leave, `lib/sidebar-leave.ts`); the
compositor runs it without layout. Once it is still, the content takes or
gives back the space in a view transition (`lib/sidebar-transition.ts`):
GPU snapshots of its old and new layout cross-fade in place while the real
content lays out once behind them. A page cannot resize without the window
waiting for it to repaint (40–300 ms by page), so that wait falls in the
short hold between the slide and the fade, while nothing moves. Do not animate the size of anything beside a
page, terminal, editor or app frame. The one remaining size animation is
the content frame's padding preview in Settings, which resizes a page shown
beside Settings for its 200 ms.

rAF gaps measure the renderer's main thread, not what reaches the screen:
a main-thread task during a compositor slide does not drop its frames.
Judge motion by `DrawFrame` intervals in a CDP trace (`cc` and
`disabled-by-default-devtools.timeline.frame` categories), and use rAF
gaps and `long-animation-frame` entries to find main-thread work. Long
frames with no script and no layout time are waiting on another process.
`Page.startScreencast` misses compositor-only motion; film with
`Page.captureScreenshot` and `Animation.setPlaybackRate`.

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
`settings` + Space or Tab selects a settings-only index. Scores combine a literal
match tier (label, then keywords, then detail), a category prior, frecency and
learned picks (ADR 0186); the fuzzy scorer joins only when nothing matches
literally, or for a row picked earlier for the query. Ranking signals load
once per opening and per new query session, never per keystroke. Render at most
80 results. Queries longer than 256 characters or
containing a newline bypass fuzzy search and remain available to agent/web actions.

Search remains linear in catalog size, plus sorting matches. A local Bun probe on
2026-09-09 measured 75 settings at 0.05 ms p95, and a synthetic 10,000-resource
index at 15.4 ms p95 across literal, abbreviated and missing queries (30 samples).
These are search-function timings, not Electron keystroke-to-paint latency or a
portable performance guarantee. Native tests cover the actual typing/navigation
flow. If real workspaces grow beyond this budget, measure their query distribution
before adding a worker or a more complex index.

`renderer/palette/rank.test.ts` covers bounded large-index results and long
input. Preserve the prepared-index boundary and result cap when adding providers.

## Changes subscriptions

[ADR 0149](../../../docs/decisions/0149-observed-git-overviews.md) replaces the
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
on the OS and repository size; on macOS and Windows ignored output
notifications are filtered after delivery, not excluded from the OS watch (see
the Linux section below). This is not an overnight soak.

Reproduce with `bun apps/desktop/scripts/git-overview-benchmark.mjs <fixture>
<poll|watch> [idle-seconds] [edit-delay-ms]`. The script requires a disposable
Git fixture and refuses one containing its reserved probe file. It creates only
that file, then removes it. Run each mode on the same clean synthetic repository;
use `/usr/bin/time -l` on macOS for process-plus-child CPU. `poll` isolates the old
15-second schedule using the current reader; for a historical whole-backend
comparison, set `GIT_OVERVIEW_BASELINE` to an extracted pre-change `git-view.ts`
module whose package imports resolve in the worktree. The numbers above used
the historical reader.

### Linux watch budget and sustained writes, 2026-09-22

Measured on the rebased branch (main `ab14403f`), same M3 Pro. The synthetic
fixture was rebuilt to the same shape (21,002 tracked, 10,000 ignored); the
table above reproduced within noise (idle scans 0; edit latency 467 / 499 /
545 ms against 14,769 / 8,311 / 1,767 ms polling; process-plus-child CPU
0.85 s against 2.0 s).

Linux, in the `node:24.13.0-bookworm-slim` image with this monorepo mounted
(27,675 directories, 209 holding tracked files):

| Watch strategy | inotify watches | Setup |
| --- | ---: | ---: |
| Node recursive `fs.watch` on the checkout | 282,264 | 34.9 s |
| Walked watch over non-ignored directories | 209 | 32 ms |

The image's `max_user_watches` was 1,048,576; older distributions default to
8,192, where the recursive strategy fails outright and the monitor would fall
back to two-minute reconciliation. The walked strategy is used on Linux only.

Sustained writes, an atomic save every 250 ms for 30 s (120 saves) with the
subscription live:

| | Scans | Scans per minute |
| --- | ---: | ---: |
| Debounce only | 119 | 238 |
| Debounce plus post-scan cooldown | 40 | 80 |
| 15-second polling, for reference | 2 | 4 |

Each scan of this fixture takes about 150 ms, so the cooldown holds scanning
near a fifth of wall time while an agent edits continuously, and only while a
Changes section is visible. Idle and single-edit behaviour is unchanged.

Tests cover external atomic saves, index changes, renames, deletes, commits,
linked checkouts and shared refs, ignored output with tracked exceptions, burst
coalescing, shared ownership, teardown races and fallback recovery. The Electron
Changes suite verifies visible writes/staging/removal without moving input focus.
