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
  storage, and passes none of the doctrine hooks (ADR 0049).

Main-process map (`src/main/`): `server/` embeds core (boot, agent
registry, project agents ADR 0050, workspace tools, triggers, e2e fakes);
`agent-bridge.ts` connects agent sessions to renderer surfaces;
`terminal.ts` + `terminal-text.ts` + `shell-integration.ts` are the PTY
stack; `git-view.ts` is the system-git read surface (worktrees, status,
diffs); `browser*.ts`, `profiles.ts`, `connections-store.ts`,
`mcp-apps.ts`, `sidebar-config.ts` cover browser, profiles, connectors,
MCP apps, and sidebar layers; `mobile-pairing.ts` is "Continue on
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

## Verification Checklist

Run all of these from the repository root before finalizing any major change:
"finalizing" means before you report the work as done, not merely before a
commit. A change that hasn't passed the full checklist is not done:

### 1. Typecheck

```bash
bun run --cwd apps/desktop typecheck
```

### 2. Unit tests

```bash
bun run --cwd apps/desktop test
```

### 3. End-to-end tests (required before every commit)

```bash
bun run --cwd apps/desktop test:e2e
bun run --cwd apps/desktop test:e2e:visible
```

Before completing engineering work, run `bun run check` from the repository
root. It is the merge gate, including deterministic Postgres-complete
workspace tests and both desktop E2E modes. Docker must be running so the
test commands can create their disposable Postgres database. Run credentialed
external integrations only when explicitly authorized with `bun run
test:external`.

The root `bun run test` command runs root orchestration tests and the
deterministic, Postgres-complete workspace test graph. The focused desktop
unit-test command above runs only this app's test files through the
repository-pinned Node runtime.

The default command keeps the real Electron window hidden so local runs do
not steal focus. The visible command runs the compositor, focus, and
native-window suites (`motion`, `skills`, `tool-permissions`, and
`window-state`) with a displayed window;
run both before every commit. Both commands build the app and drive the real
Electron binary over CDP against an
isolated temp `userData` dir with a deterministic fake agent
(`CATAMORPHIC_E2E_FAKE_AGENT=1`) — no API key, no microsandbox, and no
interference with a normally-running app instance. Covers the main flows:
first launch → project creation → palette New Tab, browser tabs
(open/navigate/close), chat create + send + reply, Cmd+N idempotency,
streamed preamble messages, and the ask_user question panel.

- Suites: `e2e/app.e2e.ts` (user flows), `e2e/motion.e2e.ts` (the motion
  contract from `DESIGN.md` — easing/duration bounds, enter/exit pairing,
  animate-before-unmount), `e2e/onboarding.e2e.ts`, `e2e/agents.e2e.ts`,
  `e2e/project-agents.e2e.ts` (committed agent definitions + consent),
  `e2e/recovery.e2e.ts`, and `e2e/legacy-seed.e2e.ts`. Harness:
  `e2e/harness.ts`, config: `vitest.e2e.config.ts`. A separate
  model-in-the-loop eval (`bun run test:eval`, `e2e/agent-build.eval.ts`)
  exercises real agent app-building and is not part of the required
  checklist.
- If a motion test fails after a UI change, the animation is presumed wrong,
  not the test — read the "Motion contract" section of `DESIGN.md` before
  touching the test constants.
- Tests within the file run in order and share one app instance — later
  groups assume the project created in "first launch" exists.
- The fake agent (`src/main/server/e2e-fakes.ts`) is prompt-keyed: "ask
  me ... questions" triggers the question flow, "preamble" triggers the
  multi-segment text flow, "edit a file" writes into the sandbox,
  "slowly" runs an interruptible ~4s turn (queueing/interrupt tests),
  "auth error" / "rate limit" fail the turn once with provider-style
  rejections (the retry recovers — asserting the friendly rewrite and
  retry/auto-retry paths from `server/agent-errors.ts`), any message
  with attachments echoes what arrived, and "terminal: <cmd>" /
  "terminal @<id>: <cmd>" execute the REAL `run_terminal` workspace tool
  (the only e2e path through the bridge → renderer → chips machinery).
  When adding agent-facing UI
  behavior, extend it with a new keyed prompt and cover the flow with a
  test.
- The e2e agent is a fake: nothing here exercises real model-provider
  APIs, so provider-side failures (revoked keys, quota) must be simulated
  through keyed prompts like "auth error" — never assumed covered.

### 4. Visual verification (UI changes)

Type checks and tests verify code, not feel. For UI changes, also launch
the app and check the change visually end to end (see `DESIGN.md` and the
CDP driver at `scripts/drive.mjs`):

```bash
bun run dev:desktop
# Read the `CDP:` URL printed by the development orchestrator, then:
CDP_PORT="<printed CDP port>" node apps/desktop/scripts/drive.mjs window maximize
CDP_PORT="<printed CDP port>" node apps/desktop/scripts/drive.mjs shot /tmp/app.png
```

The shared development runner unsets `ELECTRON_RUN_AS_NODE`. Main-process
changes need a full relaunch; renderer changes hot-reload. Maximize the window
before screenshots. Rebuild changed workspace packages first; the desktop
resolves them via `dist/`.

## Design log

When you and the user settle a significant desktop design or philosophy
choice, record it as a dated entry in `DESIGN.md` → "Design log" in the
same change (the desktop counterpart of the ADR rule).
