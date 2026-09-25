---
name: desktop-interactions
description: Use when changing how the Work desktop app (apps/desktop) opens resources, arranges tabs, splits, floating chats and the dock, handles scoped settings, form controls, or the chat composer, and when verifying desktop UI changes in the running Electron app or its e2e suites. Reusable chat mechanics belong in packages/react and the registry; use this skill for how the desktop consumes them.
---

# Desktop interactions

Read [apps/desktop/AGENTS.md](../../../apps/desktop/AGENTS.md) first: it owns the
commands and the desktop checklist. Then read the contract for the behavior you
are changing. The guide describes the current product; update it in the same change.

| Work | Contract |
|---|---|
| Opening resources, tabs, splits, floating chats, dock | [Workspace interactions](../../../apps/desktop/docs/workspace-interactions.md) |
| Preferences, scopes, reset, agent-editable settings | [Settings](../../../apps/desktop/docs/settings.md) |
| Chat delivery, recovery, embedding | [Chat state](../../../apps/desktop/docs/chat-state.md) |
| Idle CPU and memory | [Performance](../../../apps/desktop/docs/performance.md) |
| Loading buttons, modal stability | [Buttons](../../../apps/desktop/DESIGN.md#buttons) |
| Selects and checkboxes | [Dropdowns and checkboxes](../../../apps/desktop/DESIGN.md#dropdowns-and-checkboxes) |

Record a changed decision in an ADR or a short [design log](../../../apps/desktop/DESIGN.md)
entry. Older log entries and `DESIGN-HISTORY.md` explain past intent; they are not
instructions to restore superseded behavior.

## Rules

- Reuse the existing primitives: `shared/open-mode.ts` for open gestures,
  `renderer/lib/workspace-state.ts` transitions for workspace changes, the shared
  settings catalog in `shared/settings.ts`. Do not add a parallel path.
- Native handles, dirty-buffer prompts and animation scheduling stay in the desktop.
  Headless hooks cannot know about bubbles, tab slots or Electron.
- Rendering, unread cues and persistence must agree on surface identity. An async
  completion may only finish the conversation or layout that started it.
- Forms use semantic `<select>` and `<input type="checkbox">`, styled only by
  [form-controls.css](../../../apps/desktop/src/renderer/form-controls.css)
  (`appearance: base-select`). No JavaScript select replacements, OS-native menus,
  browser-default checkboxes or per-screen control styles.
- A new setting goes into the settings catalog and its Settings destination. Keep
  search metadata independent of live values.
- Project agents learn desktop configuration from the `configuring-catamorphic-desktop`
  host skill and the read-only `desktop_settings` tool, then edit the files directly.
  Do not add settings write tools or mirrored files.
- New per-turn facts for agents are `TurnOptions.context` fragments (ADR 0152),
  never text prepended to the user's message. Core seeds stay host-neutral and
  never import desktop code.
- A reusable component change goes into the registry source and every installed
  consumer together.

## Test at the right layer

- State sequences: pure tests of `workspace-state.ts` transitions.
- Deferred responses: hook tests.
- Hit targets, focus, clipboard, motion, native windows: Electron e2e in
  `apps/desktop/e2e/`. A hidden DOM node does not prove a floating preview is
  clickable.

Suite membership comes from `apps/desktop/vitest.e2e.config.ts`. Run one file with
`bun run --cwd apps/desktop test:e2e <name>` (a Vitest file filter). It builds the
desktop and its workspace dependencies inside a Docker image, so Docker must be
running; logs and screenshots land in `test-results/desktop-<id>/`. See
[desktop testing](../../../docs/desktop-testing.md) for the CI lanes. Never launch
the e2e harness on your own macOS session.

Writing e2e steps with `apps/desktop/e2e/harness.ts`:

- Wait for the element before acting on it. `app.waitFor(expr)` polls until the
  expression is truthy; its result must be JSON-serializable, so return a boolean
  or plain data, never a DOM node. The macOS CI shards are slower than Linux
  and flake when a step clicks or fills a form that has not rendered yet.
- Use `app.press`, `app.insertText` and `app.movePointer` / `app.clickPointer`
  for real input once focus and selection have settled. Synthetic DOM events miss
  Chromium's default editing and OS hover tracking.
- Tests in a file share one app and run in order. Running a later test alone may
  skip the state an earlier one set up.
- Extend `src/main/server/e2e-fakes.ts` for deterministic agent behavior.

## Look at it in the running app

UI changes also need a visual check in the real renderer, including narrow layouts,
light and dark themes, reduced motion, nested Escape and focus restoration when
the change touches them.

```sh
bun run dev:desktop   # prints "CDP: http://127.0.0.1:<port>"
export CDP_PORT=<port> CDP_TARGET=main
node apps/desktop/scripts/drive.mjs window maximize
node apps/desktop/scripts/drive.mjs shot /tmp/app.png
node apps/desktop/scripts/drive.mjs click '[data-testid=...]'
```

- `CDP_TARGET=main` picks the workspace window; without it the script takes the
  first page, which may be the detached dock (`CDP_TARGET=surface=dock`).
- Maximize before screenshots so the layout matches the default test viewport.
- Screenshots are in device pixels. Divide by `window.devicePixelRatio` before
  using a position from the image as CSS coordinates.
- Other commands: `hover`, `type`, `key`, `wheel`, `drag`, `eval`, `text`
  (see the script header).
- Renderer edits hot-reload; main-process and preload edits need a relaunch.
- Set `CATAMORPHIC_DEV_NO_SYSTEM_PROMPTS=1` before `bun run dev:desktop` so macOS
  Keychain and Touch ID sheets do not block the dev app. Set
  `CATAMORPHIC_E2E_FAKE_AGENT=1` for credential-free chat checks.
- Never reset the dev profile's data to prepare a check unless the user asks.
