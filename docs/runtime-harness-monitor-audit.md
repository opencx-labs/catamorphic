# Runtime, harness, and watcher audit

Status: implemented; all 12 phases of `bun run check` passed on 2026-09-08,
including 39 visible-window and 144 hidden-window Electron tests with
non-interrupting test windows enabled.

Scope: installed-app cold animation responsiveness, idle resource lifetime,
Codex/Claude Code/AI SDK capabilities, and session-owned watchers and monitors.
This work builds on main at 55a2dc5 (merged remote-experience PR #33).

## Motion

Measured the installed alpha.3 binary with an isolated profile, keeping its
packaged executable and macOS JIT crash workarounds unchanged. Cold chat opening
showed frame gaps of 146 to 615 ms, while subsequent openings reached about
15 ms. Removing only the dock's backdrop blur in the same installed binary
reduced the first opening's maximum gap to 14.9 ms. Removing only its shadow
filter did not resolve the cold stall (173 ms).

Animated desktop floating surfaces now use opaque theme backgrounds and normal
box shadows. Closed modals release their contents after their exit animation;
idle chat icons and inactive search indicators do not retain invisible infinite
animations. Retry countdowns stop scheduling once their deadline is reached.

## Harness capabilities

The pinned native Codex 0.153.4 executable was exercised against loopback model
and MCP fixtures with an isolated CODEX_HOME and no real model credentials:

- First-turn workspace file writes succeeded.
- A resumed thread wrote successfully after its working directory changed.
- Native project skill discovery included the fixture SKILL.md description.
- The host MCP todo tool was invoked successfully.
- Native private goals and subagents were absent; native execution remained.

Codex workspace-write deliberately protects `.agents`, `.codex`, and `.git`.
A direct write to `.agents/skills` reproduced an OS permission error. This is a
native sandbox boundary, not a reason to silently elevate the session. Ordinary
workspace writes work. Authorized host project tools and explicit permission
modes remain the mechanisms for protected changes.

Fixed the desktop wrapper's missing Codex interrupt capability, recoverable
transport errors poisoning otherwise successful turns, and dropped media input.
Image/document bytes now live in a private temporary directory for exactly one
turn, including resumed turns and launch failures. Tests cover cleanup.

Claude retains native file and shell tools within the selected permission mode;
its private Monitor, todo, and delegation tools yield to the host equivalents.
Plan mode explicitly excludes mutating native tools, including native Monitor execution. AI SDK disposal aborts an
active request before releasing its scoped MCP connections. Embedder choices
remain provider options; desktop doctrine stays in desktop registration.

## Idle lifetime

- Browser guest event handlers are detached when their element is replaced.
  Inactive guests use native CSS visibility scheduling; the ineffective JS
  visibility shim was removed. Automatic crash recovery is bounded to two
  attempts, followed by an explicit Reload action. An attempted correction of
  the old shim revealed a reproducible Electron context-bridge crash and
  demonstrated how the old unbounded recovery could amplify a guest failure.
- Login-form observation ignores unrelated DOM churn and deduplicates IPC.
- Agent-controlled browser tabs stop receiving the keep-awake exemption when
  all agents in their project are idle.
- Hidden, settled chat panels stop their watcher polling.
- Completed renderer bridge requests cancel their timers; permission requests
  remove abort listeners; shutdown settles pending bridge requests.
- Schedule ticks cannot overlap. Schedule and notification delivery join
  shutdown before the database closes.
- Reading stored schedule activations no longer scans every project's git
  checkout on every tick when no schedules are enabled.

## Session monitors

A watcher remains ordinary TypeScript workflow code on an isolated ref with a
temporary enablement and one owning session (ADRs 0074, 0076, and 0101). Periodic
checks use the normal schedule trigger and workflow IO. Registered Project
Events supply existing ingress. A Monitor provider is needed only for shared,
normalized event sources. Closing a chat tab does not close its session.

Fixed temporary authoring resolving to the desktop user's real checkout: a
new disposable origin checkout ignores host folder mappings and preserves the
user's uncommitted files. Publication compensates on failure. Stop, expiry
(including paused watchers), and session archive/close disable future work.
Stopped refs retire only after enrolled runs settle, with retry state persisted
in Postgres. Cloudflare mirrors prune refs retired by another server, serialize
callbacks per project, and report rejected pushes so retirement can retry. Closed sessions cannot create new watchers.

Dispatcher candidates must have unseen events or be due for expiry. Irrelevant
events advance the cursor, and recently handled watchers move behind older
ones. A failing watcher cannot abort the whole dispatch batch. Stop checks
project/session ownership before touching its enablement.

External monitor claims require a live, unexpired watcher. Poll requests have
an abort signal and 45-second deadline; shutdown aborts and joins them. GitHub
polling and token refresh propagate that signal. A stopped orphan cannot keep
polling indefinitely.

Regression tests cover normal scheduled temporary workflows and stop, event
idempotency, irrelevant-event cursor progress, ownership checks, expiry,
retirement after runs settle, worker recovery, and shutdown cancellation.

## Measured final build

The rebuilt desktop had a 14.4 ms maximum frame gap on its first and each of
three subsequent chat openings, with no long-animation-frame entries or
renderer errors. Real Electron regression coverage verifies inactive guest
animation frames stop, pages resume, and closing tabs removes their DevTools
targets. It also exercises bounded recovery without crashing real processes.

A 60-second idle sample after three fixture chat turns showed:

- Renderer task duration increased by 0.192 seconds (about 0.32% of one core).
- Main-process CPU time increased by 1.26 seconds (about 2.1% of one core).
- Collected JS heap remained near 14.9 MB (14.848 to 14.888 MB).
- DOM nodes settled at 1,541; JS event listeners settled at 255.
- Detached script states remained zero and no renderer errors were reported.

These measurements include the normal local database and worker polling. They
are observations on this machine, not performance thresholds for every host.

## Testing without interrupting the desktop

Isolated test windows are non-focusable and ignore physical mouse input.
Visible rendering tests use `showInactive()` and the macOS test app hides its
Dock icon. Invitation, profile-window, and notification paths cannot reactivate
the test app. DevTools supplies test keyboard and pointer input and emulates
page focus for visible suites. This preserves foreground query retries and
editor behavior without activating the operating-system window. A real
Electron window-state regression asserts both `focused: false` and
`focusable: false` while the page reports emulated focus. All 39 visible-window
and 144 hidden-window tests passed with this policy. Normal installed-app
windows keep normal focus. Workflow test readiness also accepts fully unmounted
closed modals instead of depending on the brief exit-animation interval.

## Verification limits

An earlier local gate attempt hit a native Node 24.13.0 V8/Wasm worker crash
(`ThreadIsolation::LookupJitPage`). The stuck test worker was terminated; an
unchanged rerun passed. No test was disabled or test-runtime workaround added.

Deterministic tests exercise real native CLI and Electron boundaries without
paid model calls. They do not prove every model will select the right tool.
Short profiling and soak tests cannot prove the absence of every overnight
leak or control arbitrary third-party page behavior. No release has been
published or installed into the user's profile as part of this audit.
