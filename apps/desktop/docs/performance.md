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

## Idle work and live chats

ADR 0229 records the measurements. An idle Work does nothing on a short
timer: the embedded server's pollers wait `idlePollMs` (5 s) after a poll
that found nothing, unless known work falls due sooner, and are woken by
the writes that queue work; the window's chat lists, attention and
watchers read again on main's "chats changed" hint, and once when a hidden
window that dropped a hint shows again, with a 30 s safety poll (remote
projects keep their 2 s polls); a routine read never shows a refreshing
state, and a view renders only when its rows changed. A window coming
back to the front reads nothing by itself (`lib/query-client.ts`): every
open project's workspace stays mounted, and refetching each one's stale
queries at once made returning to Work stutter. Only what can change
with no hint opts back in: a pull request's state, and a file shown from
disk. Streamed deltas after an item's first
are recorded in 100 ms batches. Rules that follow:

- **A timer needs a reason on screen.** Before adding a poll, interval or
  infinite animation, measure an idle app (below). Prefer a hint from the
  process that makes the change, and keep a slow poll only as a backstop.
- **Routine reads are invisible.** A poll must not read a query's
  fetching state or report `refreshing`; collections take
  `{ type: "invalidate", quiet: true }`.
- **Infinite animations cost frames for as long as they run.** Each one
  keeps the compositor and GPU drawing at the display's rate. In the
  test desktop, a working chat's five spinners and two pulses cost about
  18% of a core in the GPU process and 4% in the window over an
  otherwise quiet step (paused: 1.6% and 2.8%).

**Method.** Measurements run in the isolated test desktop with the fake
agent's `perf turn` and `perf answer` scenarios (`e2e-fakes.ts`): many
short steps with changing activity, a long quiet step, then a long
Markdown answer streamed in 40 ms chunks. A temporary suite (never
committed) launches the built app with `--inspect` for main, then over
fixed windows reads per-process CPU (`app.getAppMetrics()` cumulative
CPU), per-thread CPU (`/proc/<pid>/task`), renderer `Performance.getMetrics`
deltas, CPU profiles of main and the window (`Profiler` over CDP and the
inspector), React commits and render roots (a
`__REACT_DEVTOOLS_GLOBAL_HOOK__` installed before React loads, walking
fibers with the PerformedWork flag), timers, `requestAnimationFrame`,
observers and fetches (wrapped in an init script), main-side fs, HTTP,
IPC and PGlite statements (wrapped from the inspector), and frames from a
CDP trace. Build the renderer unminified for readable profiles. Scenarios:
idle without a project; idle with a project, three tabs and a settled
floating chat; the right sidebar open; a live turn; 120 settled turns
while a turn streams; a hidden chat working; ten discarded session
artifacts. `e2e/runtime-idle.e2e.ts` keeps the fast guard: an idle chat's
window makes no chat-list reads on a short timer and never shows a
refreshing spinner.

### Before and after, 2026-10-13

Measured in the Linux test desktop (Docker on an Apple M-series Mac,
software compositing, other work on the host), 20 s idle windows and one
28 s scripted turn, against `bfe84d6c` plus this change. Percent of one
core; statements are PGlite statements per second on the main thread.
Host load moves single runs by about a fifth, more for the window and
GPU during a turn; counts do not move.

| Scenario | Main | Window | Statements/s | React commits/s |
| --- | ---: | ---: | ---: | ---: |
| Idle, no project | 8.4 → 2–4 | 0.6 → 0.7 | 18.8 → 5.0 | 0 → 0 |
| Idle, project, three tabs, settled chat | 10.7 → 2.4 | 3.4 → 2.5 | 36.7 → 5.8 | 6.0 → 0 |
| Idle, right sidebar open | 9.2 → 1.9 | 2.8 → 0.7 | 35.5 → 5.8 | 6.1 → 0.1 |
| Idle, ten discarded session artifacts | 9.7 → 2.3 | 1.6 → 0 | 67.7 → 6.6 | 4.8 → 0.3 |
| Idle after a hidden chat's turn | 5.3 → 1.7 | 1.9 → 0 | not measured | 0 → 0 |
| Live turn (steps, quiet step, streamed answer) | 13.6 → 8–10 | 26 → 24–29 | 171 → 80 | 21 → 16 |
| Live turn after 120 settled turns | 14.2 → 10.0 | 40 → 41–48 | 171 → 80 | 20 → 16 |
| A hidden chat's turn | 16.4 → 11–13 | 6.7 → 7–11 | 159 → 73 | 5.3 → 1.6 |

The window at idle keeps the composer caret's two frames a second. During
a turn the window and GPU process are spent in the chat timeline (its
scroll-following spring, Markdown parsed again per update, every turn
rendered per update, and its loops, see above), which this change does not
touch.

## Overflow hints

A list fades the edge it continues past with a mask (ADR 0237), applied only
while an edge fades and kept by listeners, so it costs nothing at rest and
nothing for a list that fits. Measured on an Apple M-series Mac (the dev
app, hardware compositing) over four alternating 13.5 s streamed answers
("pace the work quickly at length") in a chat scrolled to its end: the
window's renderer stayed within run-to-run noise (21 to 23% of a core with
the fade, 20 to 21% without), and the GPU process spent about 2 points of a
core more (10.6 and 9.8% against 7.7 and 8.2%), the masked conversation's
extra pass while it streams.

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
  their page state and decides what keeps a page awake. Native camera,
  microphone and screen sharing grants conservatively keep a tab awake until
  navigation, including capture in an extension's private world. Changing a site
  permission away from Allow ends matching page-owned capture in that profile
  and origin; private extension worlds are outside page capture revocation.
  Test runs shorten
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

## Stranded selections

Surfaces that hide while staying mounted become inert: minimised chats,
closed palettes and modals, other projects' workspaces. Typing in a chat and
then minimising it left the document's caret in the inert composer. Inert
content holds no caret position, and Chromium recomputes the visible
selection before every frame that follows a DOM or style change
(`WidgetBase::UpdateSelectionBounds`, `FrameCaret::UpdateAppearance`), and
on focus changes (`WebViewImpl::SetPageFocus`). Each time,
`CanonicalPositionOf` walks backwards through every inert element to the
first usable position, checking each one's `content-visibility` ancestors on
the way. The cost grows with the inert content ahead of the caret.

Measured 2026-10-15 on an Apple M3 Pro, macOS 26.5.2, in an installed
0.1.0-alpha.22 (Electron 45.0.0-beta.1, Chromium 156) with a real profile:
14,356 elements, four minimised chats of 235 to 3,025 elements. CDP moved a
synthetic pointer across the window every 16 ms for 4 seconds per row; a
`toplevel` trace counted the renderer's `ScheduledActionSendBeginMainFrame`
tasks and its main-thread task time. Only the caret changed between rows:

| Caret | Frames | Average frame | Main thread busy |
| --- | ---: | ---: | ---: |
| In an open chat's composer | 197 | 3 ms | 644 ms |
| In the 3,025-element minimised chat's composer | 37, all over 50 ms | 68 ms | 3,804 ms |
| Cleared | 192 | 3 ms | 598 ms |

In the same state, 22 seconds of hovering a markdown document ran at
3.8 frames a second: the drag handle's per-frame hit test forced layout, and
each layout paid a 116 to 161 ms walk. A fresh profile with a few
fake-agent chats showed no visible stall, so the walk appears to need the
long transcripts of real chats ahead of the caret.

Only the hit-test path emits `VisibleUnits::canonicalPosition`. Under
`UpdateSelectionBounds` the walk is untraced, so a stalled frame shows a long
`ProxyMain::BeginMainFrame` with almost no style, layout or script time,
which reads like waiting on another process. A native sample tells them
apart: Electron publishes breakpad symbols for each release
(`electron-v<version>-darwin-arm64-symbols.zip`); run `sample` on the
renderer and resolve `Electron Framework` offsets against the `.sym` file's
`FUNC` records.

`lib/inert-selection.ts` releases a selection lying within one region that
turns inert, or that anything places in a region already inert; one only
reaching in is left alone. What it released returns without moving focus,
in its direction. A highlight outside any editor returns with its
container, or the ancestor whose inertness held it, if nothing else is
selected by then. A caret or highlight in an editor returns only when that editor
itself takes focus, as a restored chat focuses its composer, so typing
continues where the person left off: a selection set in an editable element
focuses it (in a focused window), so returning one with its container
would take focus, and the next key would replace a highlight. Unlike
before the guard, a document's highlight does not survive a project switch.
A press inside places its own caret instead.
`lib/inert-selection.test.ts` covers these rules; the chat-state suite's
minimised-draft test covers the chat, and `app.e2e.ts`'s "Cmd+W closes the
tab behind the floating chat when the tab has focus" fails if a caret
returns before its editor has focus.

A caret left in a tab hidden with `display: none` (inactive tabs) has no
measurable cost. Measured 2026-10-16 in a test copy at 13,372 elements,
with the caret at the end of a 1,500-paragraph document in a hidden tab
while a chat streamed in front and the pointer moved: 299 frames in 4 s at
2.6 ms average (worst 9.6 ms), against 301 at 2.8 ms with the caret
cleared. Hidden tabs stay out of the guard.

## Tab switches and closes

### Local changes stay local, 2026-10-23

Opening and dismissing a chat in an installed alpha.27 with long retained
transcripts triggered style passes over 32,000 to 50,000 elements. Individual
passes took 50 to 160 ms. The expensive geometry and focus calls were paying
for that style work, rather than spending that time in their own scripts.

Chromium's invalidation trace identified two broad selectors: Tailwind's
`group-has-[:focus-visible]` output put a descendant wildcard inside `:is`,
invalidating the document after unrelated insertions and inline style changes;
the corner-control rule's `:root:has` searched across every retained chat.
The time and webhook copy button now use row-scoped selectors. The visible
project publishes the corner toggle's clearance on the existing workspace
frame, so chat controls do not need a document-wide lookup.

In a reversible live-window comparison at about 39,000 elements, eight
identical local insertions each took 88 to 124 ms before, 3 to 8 ms with the
scoped rules, and 84 to 98 ms again after restoring the original rules.
This measures the forced style pass, not total interaction latency. The
native `style-invalidation.e2e.ts` regression adds 12,000 transcript rows and
checks the trace's element counts for insertions in the workspace, dock and
document, avoiding timing thresholds. Keyboard timestamp reveal remains
covered by `chat-motion.e2e.ts`.

The tab's corner controls have their own `data-chat-controls` attribute and a
direct header path. A descendant `data-testid` selector made switching a long
chat between floating and tab poses reconsider thousands of tool-result nodes.
The same regression now toggles that pose as well as inserting local content;
the released selector visited 12,013 elements in the test's style pass.

A tab switch shows the new tab in the frame after the press, a chat as a
page: a chat tab behind another keeps its tab pose and is hidden at once
(`visibility: hidden` and `content-visibility: hidden`, no transition), so
bringing it forward changes nothing about its box and replays no dock-in.
It used to take the minimised pose while behind, so every switch to or
from a chat played the floating chat's open or close (a 250 ms fade and
scale) and resized its transcript every frame; the scroller's resize
observer and scroll listeners then forced a layout of the whole
transcript on each of them. The composer's clearance for the bubble strip
and a split pane's geometry jump, rather than ease, for the two frames
after a chat comes forward.

Measured 2026-10-21 in the dev app with five chats of a long fake
answer and three web pages (a 30 fps screencast; frames in which the
content area changed):

| Switch | Before | After |
| --- | ---: | ---: |
| A page to a chat | 10 frames | 2 |
| A chat to a page | 8 frames | 1 |
| A page to a page | 1 frame | 1 |

Closing a tab whose pages nobody pressed, typed or keyed in closes at
once. The page's preload reports its first press, key or typing in each
frame it runs in (`catamorphic:page-activated`; Escape and a modifier
alone do not count), and main the first press it sees reach the page
(`input-event`), for frames that run no preload. Without either there is
nothing a `beforeunload` could hold, so the tab does not wait on the page
and the main process to say so. Measured on a heavy GitHub page, the ask
took up to its 400 ms limit before the next tab came forward.

## Minimised chats

A minimised chat stays mounted at opacity 0
so its draft, scroll and queued sends survive, and it went on paying
style, layout and paint for its whole transcript on every frame. Hidden,
it now carries `content-visibility: hidden` (`chat-dock.tsx`): Chromium
skips its subtree while keeping its rendering state. The value changes as
a discrete step of the panel's transition (`transition-behavior:
allow-discrete`), after the fade, so a chat leaving by its fade (Cmd+M,
another chat opening) stays drawn until it is gone; skipped at
once, it showed as an empty card for its first frames. Only that state
transitions the value, so a chat coming back is drawn at once, in time for
its composer to take focus. Its height is explicit, so nothing about its
box changes.

Measured 2026-10-16 in a test copy with three minimised chats of 2,337
elements each while a fourth streamed in front, 4 seconds per row:

| Minimised chats | Layout objects per layout | Layout time | Main thread busy |
| --- | ---: | ---: | ---: |
| Skipped (`content-visibility: hidden`) | 2,570 | 101 ms | 869 ms |
| Forced back to visible | 6,393 | 131 ms | 1,015 ms |

A chat scrolled up into its history came back at the same scroll position
(3,120 px of 9,361), and one following its latest message came back at its
end. A chat that streamed while minimised lays out what arrived in its
first restored frame, which reviewers measured as one longer frame (about
50 to 150 ms in noisy runs) rather than that work spread over the turn.
Its rows' entrance animations, which do not run while it is skipped,
start then too. Fake-agent transcripts are small; a person's real
minimised chats held about 12,000 of their window's 14,356 elements.

## Markdown drag handle

The handle (Tiptap's drag-handle extension) found the block under the
pointer with a hit test and a caret lookup (`posAtCoords`:
`elementFromPoint` and `caretPositionFromPoint`) on every frame the
pointer moved, each forcing layout, and glided between blocks on a
`top`/`left` transition, which needs layout on every frame too. Under a
busy main thread the glide skipped frames and the handle lagged.

`handle-hover.ts` takes pointer moves that stay on the block the handle
already points at, before the extension sees them, so its lookup runs once
per block. A move stays on the block when its target, which the browser
has already found, lies in the block's element, so it holds however the
block has moved (an image above it loading, the properties box growing)
and reads no layout. Moves between or beside blocks still look up, and an
edit or the handle hiding lets go. Blocks holding other drag targets
(lists, items with nested lists) and tables are never held. The extension
still places the handle box; the grip inside it glides from the box's old
place on a `transform` animation (`installHandleMotion`), which runs on
the compositor. Shown again after hiding, it appears where it lands: the
extension makes the box visible before placing it, and that placement is
not a move. The table row grip is placed and glides by `transform` the
same way.

Measured 2026-10-16 in a test copy, with screencast frames for the glide
and an injected main-thread load of 30 ms tasks every 40 ms:

| | Before | After |
| --- | ---: | ---: |
| Lookups over 60 pointer moves inside one paragraph | 60 | 1 |
| Lookups over 48 moves crossing 12 blocks | 48 | 12 |
| Lookups over 60 moves inside a paragraph, the handle already on it, while a chat streams beside it | 60 | 0 |
| Handle glide frames under load (smooth steps / one-frame jumps) | 56 / 17 | 132 / 3 |
| Handle glide frames idle | 133 / 3 | 134 / 3 |

"Before" is `main` at 124f357b; the idle and loaded glide rows are from
the same harness on the parent of #253 the day before. A lookup counts
`caretPositionFromPoint` calls, one per lookup. `markdown.e2e.ts` pins no
lookup inside a block and a transform glide; `handle-hover.test.ts` pins
which moves are held.

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

[ADR 0149](../../../docs/decisions/0149-observed-git-overviews.md) replaces
15-second polling of the project's changes with scoped main-process
subscriptions; the `work:git` source (ADR 0234) reads through them.
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
section listing `work:git` is visible. Idle and single-edit behaviour is unchanged.

Tests cover external atomic saves, index changes, renames, deletes, commits,
linked checkouts and shared refs, ignored output with tracked exceptions, burst
coalescing, shared ownership, teardown races and fallback recovery.

## Long live turns and hidden palette layout, 2026-10-24

The installed alpha.28 window became sluggish while typing and changing lurk
state in a long turn. A 20.5 s renderer trace counted roughly 179,000 DOM nodes,
with individual style passes at 266–280 ms and layouts at 536–568 ms. A closed
palette's `offsetHeight` read forced pending document layout. Lurk transitions
also removed and restored over 60,000 layout objects; rows of a live turn had
been excluded from the containment used by completed turns.

Earlier conversation rows now use the existing `content-visibility: auto` and
remembered intrinsic size even while their turn runs. Current work, rows entering
and folding notes keep layout until their motion completes. This preserves focus
rings, anchoring and the existing transitions while allowing earlier work in an
ongoing turn to skip layout.
A closed palette skips sizing and list-motion reads, and measures afresh when
opened. In a temporary live-window containment experiment, a comparable 20.1 s
sample used 2.4 ms of layout instead of 1.75 s. The samples were passive and their
workloads differ; this is diagnostic evidence, not a latency guarantee. Native
motion, navigation and a long-row workload verify behavior in isolation.

Navigation also retains its destination through transcript resizes. The scroll
library treats a shrinking row near the end as permission to follow again;
an active message glide overrides that until its destination settles. Its
resize observer disconnects on arrival or interruption and does no idle work.

A matched isolated native comparison used the same 16,160 output elements, two
lurk/expand cycles and typed draft. The longest frame interval was 183.4 ms with
the published renderer files and 16.8 ms with the corrected files. Input-to-next-
frame samples stayed below 24 ms in both quiet typing runs; the comparison does
not establish a quiet-typing speedup. Captures used software compositing while
other checks ran, and neither app reported a renderer error.
