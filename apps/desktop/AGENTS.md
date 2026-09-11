# Desktop App — Agent Instructions

The Catamorphic desktop app (Electron + React): the framework's reference
implementation and a daily-use product. Root `AGENTS.md` applies; this file
adds desktop-specific context and checks. Design system, interaction
principles, and the running design log live in `DESIGN.md` — read it before
UI work. Every interaction matters; this is a polished product, not a demo.

## What this app is

- A local-first workspace: projects are user-visible folders holding any
  kind of work (ADR 0043); browser tabs, terminals, editors, notes, chats,
  and apps are workspace tabs; the command palette (Cmd+P / Cmd+T) is the
  front door.
- A **dev shell** (ADR 0045): Claude Code runs at full fidelity (preset
  system prompt, CLAUDE.md/`.claude` settings sources), worktrees are
  discovered and diffable, Monaco diff tabs, sidebar Changes/PRs sections,
  ghostty/PTY terminals with OSC 133 shell integration.
- An embedder like any other: it boots the server in-process
  (`src/main/server/boot.ts`) on pglite + microsandbox + filesystem
  storage, and extends the host skill tier with desktop configuration guidance (ADR 0049).

Main-process map (`src/main/`): `server/` embeds core (boot, agent
registry, project agents ADR 0050, workspace tools, triggers, e2e fakes);
`agent-bridge.ts` connects agent sessions to renderer surfaces;
`terminal.ts` + `terminal-text.ts` + `shell-integration.ts` are the PTY
stack; `git-view.ts` is the system-git read surface (worktrees, status,
diffs); `browser*.ts`, `profiles.ts`, `connections-store.ts`,
`mcp-apps.ts`, `sidebar-config.ts`, `project-manifest.ts`, and
`shared/project-experience.ts` cover browser, profiles, connectors, MCP apps,
sidebar layers, project starting actions, and capability targeting.
`harness-components.ts` installs the exact integrity-pinned Claude Code and
Codex platform executable on first use; never import downloaded JavaScript
into Electron or float those release pins. `mobile-pairing.ts` is "Continue on
mobile" (ADR 0060) — the QR palette action's LAN listener that serves
the built `apps/pwa` bundle, exchanges single-use codes for device
tokens (SHA-256 hashes + persisted port in
`<userData>/mobile-pairing.json`), and proxies `/api/*` to the loopback
embedded server with bearer auth. The embedded server itself stays
loopback-only and auth-free — never expose it directly. The pairing
claim carries the profile's remote-project links + a
localProjectId→remote mirror map, and the focused chat's context, so
the phone deep-links into the open conversation and can fall back to a
project's remote server when this desktop is asleep. Contract e2e:
`e2e/mobile-pairing.e2e.ts`. The QR serves the BUILT PWA bundle, so
`bun run dev:desktop` builds `apps/pwa` before Electron starts and keeps
a `vite build --watch` running beside it (turbo.json's
`catamorphic-desktop#dev`): edit PWA source, scan again, get the new
code. Starting the desktop outside the root development runner or focused E2E
tests does not, so rebuild `apps/pwa` by hand in those cases.

## Run

Run development commands from the repository root. `bun run dev` starts the
combined desktop and stock-server manual environment; `bun run dev:desktop`
is its desktop-focused variant. The shared orchestrator assigns this worktree
its own data directories and loopback ports, so do not start a normal desktop
watcher in a checkout another session is using.

## Verification and debugging

Use the root `bun run check` merge gate before completing engineering work. It
includes typechecks, builds, deterministic Postgres-backed tests, PWA E2E and both
desktop modes. Docker must be running. Credentials do not authorize external tests.

Focused checks, from the worktree root:

```sh
bun run --cwd apps/desktop typecheck
bun run --cwd apps/desktop test
bun run --cwd apps/desktop test:e2e
bun run --cwd apps/desktop test:e2e:visible
```

Both Electron modes are required before a commit. Suite membership lives in
[vitest.e2e.config.ts](vitest.e2e.config.ts), not a manually copied list here.
Build changed packages first; desktop resolves them through `dist`. Main-process
changes require a relaunch; renderer changes hot-reload.

E2E uses isolated temporary data and a prompt-keyed fake agent, with no provider
calls. Extend [e2e-fakes.ts](src/main/server/e2e-fakes.ts) for deterministic failure
and recovery scenarios. Real provider behavior is not covered by fake success.
Tests sharing an app instance are stateful; rerunning a later test in isolation
may omit its setup. Keep teardown through app Quit and require exit code 0.
SIGKILL is reserved for explicit crash-recovery tests. Never suppress crash alerts
or disable CrashReporter to hide teardown errors.

Automated windows must not steal focus or accept physical mouse input. The visible
harness uses shown, non-focusable windows with opacity zero and CDP focus emulation.
Drive keys/pointers through CDP after input focus and selection settle. A closed
palette may still exist inside an inert ancestor. Wait for exit motion and focus
handoff before opening another palette. Native focus behavior needs a dedicated
scenario; do not remove isolation to make a test pass.

To watch isolated windows explicitly, set `CATAMORPHIC_E2E_REVEAL_WINDOWS=1`.
Capture screenshots only in visible suites; a hidden Linux window may never
produce the compositor frame that CDP capture waits for.
On Linux use a private Xvfb display with Openbox and
`CATAMORPHIC_E2E_VIRTUAL_DISPLAY=1`; never enable that flag on the user's display.

## Visual verification

UI changes also require inspecting the running app:

```sh
bun run dev:desktop
# Use the CDP port printed by the orchestrator:
CDP_PORT="<port>" bun apps/desktop/scripts/drive.mjs window maximize
CDP_PORT="<port>" bun apps/desktop/scripts/drive.mjs shot /tmp/app.png
```

For credential-free manual checks, use `CATAMORPHIC_E2E_FAKE_AGENT=1` when launching.
The root runner unsets `ELECTRON_RUN_AS_NODE`. Never reset user data to prepare a
test without an explicit request. Prefer the isolated Electron harness.

## Contract map

| Work | Current contract | Implementation |
|---|---|---|
| Tabs, splits, floating chats, opening | [Workspace interactions](docs/workspace-interactions.md) | `renderer/lib/workspace-state.ts`, `shared/open-mode.ts` |
| Preferences and reset | [Settings](docs/settings.md) | `shared/settings.ts`, `main/settings-store.ts` |
| Delivery and embedding | [Chat state](docs/chat-state.md) | `packages/react` hook/reducer, registry source |
| Idle CPU and memory | [Performance](docs/performance.md) | `scripts/desktop-soak.ts`, `e2e/runtime-idle.e2e.ts` |
| Browser control and native computer use | [Computer use](docs/computer-use.md) | `main/browser-driver.ts`, `packages/codex` |
| Styling and animation | [Design system](DESIGN.md) | tokens, list motion and native motion tests |

[DESIGN-HISTORY.md](DESIGN-HISTORY.md) records prior rationale. Current contracts
win over superseded entries. Significant accepted choices need an ADR and a short
entry in DESIGN.md. Do not re-copy full contracts into this file.

## Resource links and unavailable actions

Resource opening and composer paste follow ADR 0108 and [workspace interactions](docs/workspace-interactions.md). Use `shared/open-mode.ts` and the resource button/menu primitives: click/Enter opens here, Cmd (Ctrl outside macOS) opens a tab, Cmd+Shift opens to the side, Option/Alt opens floating. Do not add a shortcut that floats the current surface. Persist pathless clipboard files when they cannot be sent as model media; never silently discard them.

Use the shared `surface-link.ts` resolver for agent-visible destinations. Keep
workflow/app targets aligned with `open_surface` and the workspace tab keys.
Changes to chat Markdown link handling belong in the registry source and both
installed consumers. Preserve the sanitizer for image URLs and protocols the
host does not handle. Test clicked links in the real Electron renderer.

Use Collapsible for sidebar nesting, the shared InspectorPortal for rich hover
cards, and `data-disabled-reason` beside each disabled condition. Do not rely on
native title tooltips. When editing a failure-prone picker, preserve an actionable
error/retry state and diagnostics that distinguish request failure from no matches.

## Workflow authoring

The desktop owns workflow details, source editing, draft protection, and run or
automation actions in `screens/workflow-screen.tsx`. Compose the scoped canvas
and headless hooks; do not move the inspector back into `@catamorphic/ui`
(ADR 0097). Keep the canvas mounted through inspector changes and preserve the
last valid preview while code is incomplete. The visible
`e2e/workflows.e2e.ts` suite covers live source polling, graph transitions,
source access, draft restoration and conflicts, and contextual agent editing.

Search, consent and resource links follow ADR 0123 and the linked workspace/chat
contracts. Do not add duplicate file pickers, sidebar search inputs, default note
filler, or global alerts for session approvals. Agent deliverables use semantic
workflow/app links. Editable code must derive its palette from the resolved host
theme. Verify waiting requests across tab switches, reload and interruption.
