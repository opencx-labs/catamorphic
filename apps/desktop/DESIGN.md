# Catamorphic Desktop — Design System

The desktop app aims for the OpenCode / Obsidian feel: minimal chrome, system-first,
terminal-editor calm. Everything visual flows from the tokens in
[`src/renderer/styles.css`](src/renderer/styles.css).

This file is the **source of truth for the whole Catamorphic design
language** — the website and any future surface follow it, never the
reverse. The cross-surface summary lives in
[`docs/DESIGN-LANGUAGE.md`](../../docs/DESIGN-LANGUAGE.md).

**North star: this is a really high-quality product meant for daily use.
Every user interaction matters and should be polished.** When in doubt,
spend the extra effort on the transition, the empty state, the keyboard
path, the edge case. Test every UI change visually, end to end, before
calling it done.

**Second founding idea: the desktop is the proving ground, and polish flows
upstream.** The app exists to feel amazing AND to be the framework's
reference implementation; any enhancement to a reusable surface (chat,
timelines, sessions, editors, runs) must be ported back to the installable
packages/registry so embedders get it too. A desktop-only improvement to a
shared surface is a process bug, not a win. See the [historical log](DESIGN-HISTORY.md) for its rationale.

## Principles

1. **System-first.** New profiles follow the operating system, resolving to
   Catamorphic Light or Catamorphic Dark. An explicit theme selection stays
   fixed until the user changes it.
2. **Flat depth.** Hierarchy comes from surface steps and 1px borders, not drop
   shadows. Shadows are reserved for true overlays (menus, dialogs).
3. **One accent.** A single Catamorphic orange. If something needs to stand
   out beyond the accent, the layout is wrong, not the palette.
4. **Desktop density.** 13px base type, 28px list rows, 4px spacing grid. This
   is a tool, not a marketing page.
5. **Registry components are themed only through tokens.** Never edit installed
   files under `src/renderer/components/catamorphic/` for visual tweaks — adjust
   tokens, or improve the component upstream in `packages/registry`.
6. **No decorative motion.** Every animation is a state-change signal (hover,
   expand, enter, exit) on the standard easing. Nothing loops or bounces. The
   exact rules are the "Motion contract" section below — and they are enforced
   by `e2e/motion.e2e.ts`.

## Typography

| Token | Value | Use |
|---|---|---|
| `--font-sans` | Inter, system-ui | UI chrome, body text |
| `--font-mono` | JetBrains Mono, ui-monospace | code, logs, ids, timestamps |

These are defaults. Each profile can override `fonts.sans` and `fonts.mono`
in `theme.json` or Settings > Theme using installed CSS font stacks.
Removing a key restores its default. Font choices survive color preset
changes and apply live to the shell, editors, terminals, and themed apps.

Type scale (px): 11 (labels/badges), 12 (secondary), 13 (base), 14 (emphasized),
16 (panel titles), 20 (page titles). Base is 13px set on `body`.

## Color tokens

Semantic layer only — components never hardcode hex values.

### Surfaces
| Token | Dark anchor | Role |
|---|---|---|
| `--color-bg` | `#0a0a0b` | app background |
| `--color-bg-raised` | `#101012` | cards, panels |
| `--color-sidebar` | `#101012` | sidebar and window frame |
| `--color-bg-overlay` | `#16161a` | menus, dialogs, hover states |
| `--color-bg-inset` | `#060607` | chat input, code blocks, wells |

### Borders
`--color-border` (default 1px hairline), `--color-border-strong` (focus/active).

### Text
`--color-fg` (primary), `--color-fg-muted` (secondary), `--color-fg-faint`
(placeholders, disabled).

### Accent
`--color-accent` (Catamorphic orange `#f95225` dark / `#d63c0c` light) with
`--color-accent-fg` for text on accent. Used for: primary buttons, active
selection indicators, focus rings.

### Status
Low-chroma so run states don't scream: `--color-success`, `--color-warning`,
`--color-danger`, `--color-info`. Used by the runs panel and toasts.

### Message tints
`--color-user-tint` (user bubbles, faint blue-slate), `--color-agent-tint`
(assistant, same as raised surface — the agent is "part of the app").

## Buttons

- **A button never changes size across its states.** Use `<PendingButton>`
  (`components/pending-button.tsx`): it stacks the idle label, the pending
  content, and (optionally) a done label in one grid cell so the button
  always reserves the width of the widest, and state changes merely toggle
  visibility. Pending shows a **spinner in the label's footprint** by
  default; pass `pendingLabel` only when words carry information
  ("Cloning…"). Use `done` + `doneLabel` ("Installed") for the state after
  the action — never swap the button for a text span, that reflows the row.
  Never swap a button's child text on `pending ?` directly.
- Fixed-height button labels never wrap or flex-shrink. The shell's stacked
  label and `@catamorphic/app/ui`'s `.cat-btn-stack` reserve max-content width;
  app-kit buttons are non-shrinking flex items by default. Containers must
  wrap or choose shorter copy instead of crushing a control into two lines.
- Pending (and done) buttons are disabled (PendingButton enforces this).
- **Every icon-only button gets a `ShortcutHint` tooltip.** A button whose
  meaning isn't carried by visible text must be wrapped in
  `<ShortcutHint label="…">` (plus `shortcut` when one exists) — never the
  native `title` attribute, which times and styles differently. Applies to
  toolbars, pills, chips, strips, bubbles; registry components stay
  presentational and inherit hints from their hosts where applicable.

## Shape & spacing

- Radii: `--radius-sm` 4px (inputs, chips), `--radius-md` 6px (buttons, list
  rows), `--radius-lg` 10px (panels, dialogs).
- Spacing on a 4px grid. Common paddings: 8 (compact), 12 (row), 16 (panel).
- Sidebar rows are 28px tall; workspace tab rows are 32px; sidebar width
  260px; right panel 380px.
- Borders over shadows: `1px solid var(--color-border)`.

## Motion contract

The rules that keep the app feeling like one system as it grows. They are
**enforced by `e2e/motion.e2e.ts`** — changing a value below is fine, but do
it deliberately: update the CSS, this section, and the test constants in the
same change. If a new animation fails the suite, the default assumption is
the animation is wrong, not the test.

### The rules

1. **One easing.** All motion uses `--ease-standard`
   (`cubic-bezier(0.2, 0, 0, 1)`). No `ease-in-out`, no springs, no bounces.
2. **Duration bounds: 100–300ms.** Micro-feedback (hover, color) sits at
   100–150ms; structural motion (panels, tabs, docks) at 180–250ms. Anything
   longer reads as sluggish; anything shorter as a glitch.
3. **Nothing loops** except indeterminate-progress indicators
   (`animate-spin`, `animate-pulse` on loading states).
4. **Paired motion mirrors.** A surface's exit is its enter reversed: same
   duration (±50ms when an exit is deliberately snappier, like `tab-out`),
   same easing, and the exit's resting pose equals the enter's starting pose.
   When open and close use separate keyframes (the chat dock), their durations
   must be equal.
5. **Animate before unmount.** Nothing that animated in may vanish
   instantly. Exit pattern: keep the element mounted with an `animate-*-out`
   class (or a transition to the hidden pose), remove it on
   `animationend`/after the duration. Width-collapsing exits swallow their
   flex gap with a negative margin so neighbors slide, never snap
   (`tab-out`, `bubble-out`).
6. **Transitions only on state changes** — hover, focus, expand/collapse,
   enter/exit. Never on load, never ambient.

Tab frame previews transition the workspace margins and corner radius over
200 ms with the standard easing. Reduced motion applies the frame immediately.

### Current motion inventory

| Animation | Duration | Pairs with |
|---|---|---|
| `dock-in` / `dock-out` | 250ms | each other |
| `bubble-in` / `bubble-out` | 200ms | each other |
| `tab-in` / `tab-out` | 200ms / 180ms | each other (exit snappier) |
| `fade-in` / `fade-out` (modal section swap; agent-control overlay) | 200ms | each other (exact mirror; `fade-out` holds its final frame for removal on animationend) |
| `pairing-qr-in` (QR readiness reveal) | 200ms | — (one-shot content-ready signal inside a fixed stage) |
| `profile-veil-in` / `profile-veil-out` (in-place profile switch) | 200ms | each other (exact mirror) |
| `question-in` (ask_user panel) | 260ms | — |
| `pane-in-left` / `pane-in-right` (keyboard tab cycling) | 200ms | — (content-changed signal on a persistent wrapper; no exit to pair) |
| `bubble-ask` (agent question arrival) | 280ms | — (one-shot nudge on a persistent bubble; no exit to pair) |
| `input-recall-{up,down}-{a,b}` (composer ↑/↓ history) | 150ms | — (transform-only directional content signal; paired names replay rapid same-direction recalls without a classless frame) |
| `title-change` (rename flash) | 1200ms | **sanctioned exception** — the
  one decorative-adjacent signal (see design log 2026-07-31); allowlisted in
  the test's `DURATION_EXCEPTIONS` |

### Sanctioned exceptions

- `animate-spin` / `animate-pulse`: indeterminate progress may loop.
- `title-change` (1200ms): a deliberate noticed-but-calm rename signal.

New exceptions require adding to both this list and the test allowlist —
that friction is intentional.

## Layout

```
┌───────────┬──────────────────────────────────────┐
│  sidebar  │ drag ▸ ⧉ ▸ [wf tab][app tab][chat]   │  ← one 40px chrome row
│  260px    ├──────────────────────────────────────┤
│           │                                      │
│ workflows │        active tab content            │
│ apps      │  (workflow canvas / app / chat)      │
│ chats     │                                      │
│           │        ○ ○ ○ +  ‹bubble strip›       │
│ ⚙ settings│                                      │
└───────────┴──────────────────────────────────────┘
```

- One chrome row: the macOS drag region (`titleBarStyle: hiddenInset`,
  `.app-drag`), sidebar toggle, and the workspace tab strip share the top
  40px. No dead space above tabs.
- Workspace tabs host workflows, apps, and chats alike; minimized chats live
  in the bottom bubble strip (see the design log for collapse behavior).
- Empty states are quiet: one sentence of `--color-fg-muted` + one action.

## Registry component rules

- **Hosts own workspace chrome.** Registry components may expose local controls
  such as queue editing, retry, and dismiss. Resource navigation and surrounding
  workspace actions are callbacks, never desktop API calls. Compose small pieces
  so an embedder can supply its own presentation.
- **Prefer small composable pieces over all-in-one shells.** The workflow
  surface is composed from `WorkflowCanvas` (graph + minimap + controls),
  a desktop-owned workflow inspector, and `WorkflowEditorScope` (shared atoms) — not the monolithic
  `WorkflowEditor`. Hosts own the toolbar, save button, and chat placement.

## Theming rules

- New colors enter as a semantic token in **every preset** in
  `src/main/theme.ts` (the source of truth for palettes), in the paired
  `light-dark()` values in `styles.css` (the pre-JS first paint), and
  documented here — then used via Tailwind (`bg-bg-raised`, `text-fg-muted`, …).
- The active theme lives in `<userData>/profiles/<id>/theme.json`
  (`{ selection, overrides, fonts? }`) — profile-local, file-watched, agent-editable.
  `selection: "system"` resolves to the Catamorphic Light or Dark preset and
  follows operating-system changes live.
  ThemeProvider writes each resolved color as an inline CSS variable on
  `<html>`, sets `color-scheme`, and mirrors the appearance to
  `data-theme` for anything keyed on it.
- The Catamorphic Light and Dark presets in `theme.ts` and the paired
  `light-dark()` values in `styles.css` must stay identical. `:root` follows
  the operating system for the pre-JS first paint.
- Tokens are mapped into Tailwind 4 via `@theme inline` so utilities and
  registry components pick them up without a config file.

## Current interaction contracts

Read the guide for the behavior being changed. These describe the current product;
the historical log explains how it arrived here.

- [Workspace interactions](docs/workspace-interactions.md): resource opening, tabs,
  floating chats, splits, visibility, sidebar defaults and transition ownership.
- [Settings](docs/settings.md): scopes, inheritance, reset and agent-editable files.
- [Chat state](docs/chat-state.md): delivery, execution, recovery and embedding.
- [Performance](docs/performance.md): idle lifecycle checks and sustained measurement.

## Design log

- 2026-09-09: Accepted [ADR 0109](../../docs/decisions/0109-desktop-state-and-settings-contracts.md).
  Workspace transitions and chat delivery have explicit owners. Ordinary appearance
  settings support per-key inheritance and reset. Current contracts are separated
  from the historical journal.
- 2026-09-09: Accepted [ADR 0110](../../docs/decisions/0110-discoverable-desktop-settings.md).
  The palette uses a shared settings catalog. Search can target
  an individual control; host-provided guidance describes live scoped edits.
- 2026-09-09: Accepted [ADR 0111](../../docs/decisions/0111-direct-desktop-configuration.md).
  Agents edit the same configuration files as the UI. Live context supplies exact
  paths; invalid edits retain the last valid configuration and surface file errors.
- [Earlier decisions and rationale](DESIGN-HISTORY.md).

- 2026-09-10: Accepted [ADR 0118](../../docs/decisions/0118-review-navigation-and-code-rendering.md).
  Pierre Diffs and Shiki share code themes. File sidebars search paths; content
  search lives in Cmd+P and reviews. Guide uses original path-based navigation.
  Changes follows the active checkout and stops polling while hidden.

- 2026-09-10: [ADR 0113](../../docs/decisions/0113-desktop-workspace-frame-and-local-pr-access.md)
  makes workspace inset, rounding and separators independent settings. Right sidebar
  collapse lives in its header. Empty pin targets remain visible; inspectors yield to drags.

- 2026-09-10: [ADR 0114](../../docs/decisions/0114-focused-pull-request-review.md)
  removes duplicate PR file trees, consolidates search and display controls,
  and separates overview metadata, local guide, changes and discussion.

- 2026-09-10: [ADR 0115](../../docs/decisions/0115-native-review-conversation.md) gives Discussion its own thread list, persistent composer, local drafts and native inline replies through the existing CLI account.

### 2026-09-10: Saved bookmarks and readable review prose

Browser imports go into the profile library, not the pinned grid. Pins are explicit
shortcuts; saved folders survive pinning and unpinning (ADR 0116). The sidebar gives
pins, saved bookmarks, and project bookmarks their own labels and bounded scrolling.

Review Overview uses a raised description card with a 72ch reading measure, stronger
heading levels, and separate bordered disclosures. Markdown in chats keeps its own
density. Theme tokens supply all surface, border, and text colors.

### 2026-09-10: Optional GitHub CLI connection

Connections offers an explicit, per-profile GitHub CLI option with account checking
and local disconnect. PRs link to this setting when disabled instead of silently
using the machine login. MCP agent tools remain separate (ADR 0117).

Rich attachment previews share InspectorPortal across composer and conversation. File references use compact pills; web links retain prose styling with destination cards. Content loads only on inspection, and unavailable previews retain useful metadata. See [chat state](docs/chat-state.md).

Browser tools wake only the guest they operate on and restore focus after native
input. In-page pointers use the same `point_at`/`clear_pointers` contract as shell
pointers. Native computer access is an optional profile connector with the
existing queued consent UI; cancellation withdraws the request. See
[Computer use](docs/computer-use.md) and ADR 0112.

## Persistent project workspaces and dock

Project switching changes visibility without disposing work. A profile can
share its dock across projects, detach it above native windows, and place it
on either edge. Project colors remain scoped to their chats and workspace.
Cross-project resource navigation uses a subtle accent tint and honors reduced
motion. See [ADR 0121](../../docs/decisions/0121-project-workspaces-and-shared-chat-dock.md)
and the [workspace interactions](docs/workspace-interactions.md) contract.

## Observability

The desktop exports logs, traces, and metrics through standard OTEL settings.
Machine settings and committed project defaults select local and remote destinations independently.
See [OBSERVABILITY.md](../../OBSERVABILITY.md) and ADR 0119 for configuration.

### 2026-09-10: Answer questions while agents keep working

Question batches can be blocking or non-blocking. "Answer when ready" panels stay
answerable while the agent works; collapsing preserves the draft. Answers reach
the running built-in, Codex or Claude Code harness as soon as it can accept input.
Late answers continue an idle session. See ADR 0122.

### 2026-09-10: Conversation consent and one search surface

[ADR 0123](../../docs/decisions/0123-desktop-consent-search-and-resource-links.md)
removes default project notes and duplicate file pickers. Sidebar searches open
scoped palettes from header buttons. "Ask agent" stays short and names the agent.
Consent appears as a durable question in its chat. Workflow and app links identify
and open their actual surfaces. Editable code derives syntax, background, gutters,
selection, cursor, diagnostics and widgets from the current app theme, with bundled
Shiki grammars. Never ship a preset editor background that ignores the app theme.
