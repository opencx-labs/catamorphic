# Desktop App — Agent Instructions

The Catamorphic desktop app (Electron + React). Root `AGENTS.md` applies;
this file adds desktop-specific checks. Design system and interaction
principles live in `DESIGN.md` — read it before UI work.

## Verification Checklist

Run all of these from `apps/desktop` before committing any change:

### 1. Typecheck

```bash
bun run typecheck
```

### 2. Unit tests

```bash
bun run test
```

### 3. End-to-end tests (required before every commit)

```bash
bun run test:e2e
```

Builds the app and drives the real Electron binary over CDP against an
isolated temp `userData` dir with a deterministic fake agent
(`CATAMORPHIC_E2E_FAKE_AGENT=1`) — no API key, no microsandbox, and no
interference with a normally-running app instance. Covers the main flows:
first launch → project creation → palette New Tab, browser tabs
(open/navigate/close), chat create + send + reply, Cmd+N idempotency,
streamed preamble messages, and the ask_user question panel.

- Suite: `e2e/app.e2e.ts`, harness: `e2e/harness.ts`, config:
  `vitest.e2e.config.ts`.
- Tests within the file run in order and share one app instance — later
  groups assume the project created in "first launch" exists.
- The fake agent (`src/main/server/e2e-fakes.ts`) is prompt-keyed: "ask
  me ... questions" triggers the question flow, "preamble" triggers the
  multi-segment text flow, "edit a file" writes into the sandbox. When
  adding agent-facing UI behavior, extend it with a new keyed prompt and
  cover the flow with a test.

### 4. Visual verification (UI changes)

Type checks and tests verify code, not feel. For UI changes, also launch
the app and check the change visually end to end (see `DESIGN.md` and the
CDP driver at `scripts/drive.mjs`):

```bash
env -u ELECTRON_RUN_AS_NODE bunx electron-vite dev -- --remote-debugging-port=9333
node scripts/drive.mjs window maximize
node scripts/drive.mjs shot /tmp/app.png
```

`ELECTRON_RUN_AS_NODE` must be unset (IDE extension hosts export it);
main-process changes need a full relaunch, renderer changes hot-reload.
