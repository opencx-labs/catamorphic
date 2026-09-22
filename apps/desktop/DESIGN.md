# Catamorphic Desktop — Design System

App identity uses canonical semantic icons (ADR 0125). Review, dashboard,
report, tracker, form, and calculator each have one monochrome glyph across
tabs, lists, and chat surfaces. Agents choose a type at creation or through a
deferred presentation capability (ADR 0133).
Unspecified or unknown types retain the grid icon. Icon changes do not rebuild
or publish an app; temporary app titles come from their retained metadata.

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

## Contained project workspace

Catamorphic capabilities live in `.catamorphic/`, including the independent Bun
workspace, workflows, apps, agent definitions, skills, and shared settings
(ADR 0142). Persistent project data lives in its ignored `app-data/` directory.
Opening an existing folder creates nothing. Desktop-wide state and temporary
build/runtime files remain outside the project. Existing package manifests and
root instruction files belong to the user's project and are never scaffolded.

## Opening existing projects

Opening a folder adopts it in place without adding files, copying history, or
requiring Git (ADR 0141). Existing repositories retain their branch, index,
remotes, and pending changes. Plain folders support ordinary agent work; an
explicit commit initializes Git when needed. Imports keep manual commits and
sharing. While an import is running, its source and destination stay fixed and
the modal shows progress until it completes or exposes a retryable error.

## Session reminders

Session reminders persist until delivered or cancelled, with no default expiry
(ADR 0139). Local reminders run when this desktop is available. Archiving lists
and cancels the session tree's reminders and monitors; closing a chat leaves them
enabled. Attention belongs to an attributed message, and notification clicks open
that message. Late delivery shows the original scheduled time.

## Principles

File and proposal lifecycle (ADR 0136): new personal files stay on this device
by default, including inside company projects. A file's top controls use the
same status inspector as chat: actual location, Save, Publish, and Propose.
The Proposals sidebar reuses PR review. Members submit selected files through
the company host; builders approve or apply the reviewed revision with their
own repository identity. Worktrees serve independent repository work, not
ordinary documents, privacy, or the existence of a proposal.

1. **System-first.** New profiles follow the operating system, resolving to
   Work Light or Work Dark. An explicit theme selection stays
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
  Fade the stacked labels over 150 ms, respect reduced motion, and stop hidden
  spinners. Keep padding, borders, height and surrounding action-row geometry
  constant. Reserve status space in modals before an action starts, so a loading
  message cannot move the footer or recenter the dialog. Verify bounding boxes
  during the real idle-to-pending transition, not only after it settles.
- Fixed-height button labels never wrap or flex-shrink. The shell's stacked
  label and `@catamorphic/app/ui`'s `.cat-btn-stack` reserve max-content width;
  app-kit buttons are non-shrinking flex items by default. Containers must
  wrap or choose shorter copy instead of crushing a control into two lines.
- Pending (and done) buttons are disabled (PendingButton enforces this).
  Completed setup actions read as status rows: explicit completion text, a success
  check, a quiet filled surface and no interactive outline or hover response.
  Use the shared `browser-setup-action` treatment for import and default-browser
  setup. Unavailable actions use muted text and explain their reason visibly;
  hover-only hints are supplementary. Reserve space for asynchronous reasons so
  later actions do not shift. `data-action-state` exposes the shared button state
  for host styling without duplicating its logic.
- **One button vocabulary.** A rectangular action takes a role class from
  `styles.css` instead of a private recipe: `button-primary` (accent) for the
  action a surface asks for, including every "Add" and "Save"; `button-secondary`
  for peers; `button-ghost` for Cancel and dismissals; `button-danger` for
  destructive confirms. `button-sm` is the only size modifier (card and category
  headers); utilities may add width or margin, never colors. Icon-only send
  buttons and pills are the sanctioned exceptions, counted in `design-lint`.
- **Every icon-only button gets a `ShortcutHint` tooltip.** A button whose
  meaning isn't carried by visible text must be wrapped in
  `<ShortcutHint label="…">` (plus `shortcut` when one exists) — never the
  native `title` attribute, which times and styles differently. Applies to
  toolbars, pills, chips, strips, bubbles; registry components stay
  presentational and inherit hints from their hosts where applicable.

## Dropdowns and checkboxes

Every desktop dropdown and checkbox must look like Work, including those
inside registry components. Never use operating-system select menus or browser
default checkbox chrome. The single implementation is
[`form-controls.css`](src/renderer/form-controls.css), imported by the host.
Use semantic `<select>` / `<option>` and `<input type="checkbox">` with accessible
labels. Electron 43 supports `appearance: base-select`: its picker renders in
the app's top layer with native keyboard navigation, typeahead and form behavior.
Do not add a JavaScript select replacement or per-screen checkbox styling.

Match project/profile menus: overlay surface, hairline border, 10px outer radius,
6px rows, 13px type, selected accent checkmark and 32px minimum choice rows.
Open and close use paired 150ms opacity/translation on the standard easing;
checkbox marks animate opacity/scale over 150ms. Respect reduced motion. Disabled
controls retain their label and explain why. A picker owns Escape before its
dialog; selecting a value or dismissing it restores the trigger's focus.

Verify pointer and keyboard selection, nested Escape, disabled/indeterminate
checkboxes, light/dark themes, long labels, narrow layouts and reduced motion.
`e2e/browser-import.e2e.ts` covers the shared import controls and onboarding.
External website and user-app content retain their own UI; this contract governs
the desktop shell, including its registry components and document task lists.

## Shape & spacing

- Radii: `--radius-sm` 4px (inputs, chips), `--radius-md` 6px (buttons, list
  rows), `--radius-lg` 10px (panels, dialogs).
- Spacing on a 4px grid. Common paddings: 8 (compact), 12 (row), 16 (panel).
- Sidebar rows are 28px tall; workspace tab rows are 32px; sidebar width
  260px; right panel 380px.
- Borders over shadows: `1px solid var(--color-border)`.
- **One border, one ring, one radius.** A control, row, tile, card or popover
  is one rounded box: its focus ring is drawn on that box with that box's
  radius (inside it when neighbours could cover it), never on an unrounded
  child inside it, and never in addition to the box's own border. Nested
  bordered boxes, square rings inside rounded ones, and a ring beside a border
  are defects; check every new surface with keyboard focus before shipping.

## Motion contract

The rules that keep the app feeling like one system as it grows. They are
**enforced by `e2e/motion.e2e.ts`** — changing a value below is fine, but do
it deliberately: update the CSS, this section, and the test constants in the
same change. If a new animation fails the suite, the default assumption is
the animation is wrong, not the test.

### The rules

0. **Reduced motion is universal.** `styles.css` collapses every transition
   and keyframe to an instant change under `prefers-reduced-motion: reduce`
   (a hair above zero so `animationend`/`transitionend` still fire) and
   nothing loops. Script-driven motion takes its duration from
   `lib/motion.ts` (`motionMs`), never a literal.

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

Framed content previews transition the workspace margins and corner radius over
200 ms with the standard easing. Reduced motion applies the frame immediately.

### Current motion inventory

| Animation | Duration | Pairs with |
|---|---|---|
| `dock-in` / `dock-out` | 250ms | each other |
| `bubble-in` / `bubble-out` | 200ms | each other |
| `tab-in` / `tab-out` | 200ms / 180ms | each other (exit snappier) |
| `fade-in` / `fade-out` (modal section swap; agent-control overlay) | 200ms | each other (exact mirror; `fade-out` holds its final frame for removal on animationend) |
| `modal-in` / `modal-out` (dialog panel: opacity + scale 0.96↔1) | 200ms in, 160ms out | the backdrop's `fade-in`/`fade-out`; `modal-out` holds its final frame until the backdrop unmounts both |
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
- Empty states are quiet: one sentence of `--color-fg-faint` + one action. Errors stay `--color-fg-muted`.

## Page surfaces

Settings, History, and any other full-tab page share one shape. The recurring
mistakes these rules prevent: a scrollbar floating mid-window, a search field
that duplicates the palette, an X that duplicates the tab strip, and blocks of
the same page styled three different ways.

- **Pages are tabs, so the tab strip closes them.** No close button inside a
  page header. Cmd+W and the tab's own close control are the only way out.
  Dialogs, menus, and floating surfaces keep their own dismiss because they are
  not tabs.
- **Search is a header icon button that opens the palette in that page's
  scope** (`settings`, `history`, or a section scope), never an inline filter
  field on the page (ADR 0123: one search surface). The page keeps its full
  content while the palette does the finding.
- **The scroll container spans the full pane width.** Whatever scrolls fills the
  content area edge to edge so the scrollbar sits at the pane's edge; centered
  `max-w-*` content lives *inside* the scroller, never around it. Sticky rails
  such as a category nav are positioned inside the same scroller.
- **One heading per category, one card shape per block.** A category starts
  with a `text-base font-semibold` heading row (optional action at the far
  right), then `.settings-card` blocks: 16px padding, a heading row with the
  block's status text at the far edge, one description sentence in
  `text-xs leading-5 text-fg-muted`, then a control row of 32px buttons. Cards
  are 16px apart, categories 40px apart. Never mix a card and a bare text block
  in the same category, and never nest a bordered card inside a card: rows
  inside a card are plain hover rows, and pickers are the only bordered
  children. A list on a page is not filtered in place; the palette scope finds
  its rows and deep-links to them.
- **No frame by default.** Content sits flush with the sidebars with no
  border, inset, or rounding. "Framed content" is an opt-in workspace setting
  that insets the workspace as a rounded, bordered window; the padding and
  radius settings are that frame's dimensions.
- **Forms and confirmations open in dialogs.** Adding or editing a record
  (a password, a macro, a connection challenge) and confirming a destructive
  action (delete a profile or a password) open the shared `Modal`, centered
  in the window with its entrance and exit motion. A page never grows a form
  or a confirm strip in place: that shifts everything below it with no
  motion. Disclosures that reveal existing content in place (theme color
  overrides) use `Collapsible`. Keep the dialog's subject in state through
  its exit so the content does not vanish mid-fade.
- **Deep links land on exactly one card.** Every palette destination resolves
  to a `data-setting-id` on a single block; category-wide outlines mean the
  catalog id is too coarse.

## Sidebar sections

Every section, built in or user defined, is the same kind of thing: a source of
rows inside shared chrome. The chrome owns status; sections own rows.

- **One status language.** A section reports `{state, refreshing, error, retry,
  empty}` and renders rows only. The section header shows a small spinner while
  loading or refreshing and a hover-revealed Refresh button otherwise; the body
  shows three still skeleton rows before the first result, one muted sentence
  when empty (`section.empty` in `sidebar.js` replaces it), and the error with
  Retry when a read fails. Rows stay on screen during a refresh; collapsing and
  re-expanding never discards what was already loaded.
- **No private loading text.** "Loading…", spinners, skeletons, empty copy and
  error paragraphs inside a section component are defects.
- **One drag-and-drop model.** The shared `Tree` owns pointer math, the accent
  insertion line between rows and the accent outline on the row (or tree) that
  becomes the parent. A section only declares what a row offers when dragged and
  what a target accepts, through the same `move`/`drop` contract custom sources
  export; built-in sections implement that contract over their stores. Rows with
  children are the only "inside" targets. No section owns drop zones, drop-zone
  classes or payload formats of its own; `data-bookmark-drop`-style private
  attributes are defects.
- **Rows and tiles.** A row's overflow menu button appears on hover; a tile
  has no room for one and opens the same menu on right-click only. Keyboard
  focus rings sit inside the row (negative outline offset, above siblings) so
  stacked rows never cover or clip them.
- **Groups inside a section are subsections.** `SidebarSubsection` is the only
  way to label a sub-list: the same quiet label row every section uses, with
  the section chevron and collapsible motion when `collapsible`. A section whose
  title already names its content leaves its main groups unlabelled; Bookmarks
  labels only "This project".
- **Hover controls share one reveal.** Overflow dots, close and open-in-window
  buttons on rows, tabs and bubbles use the `row-reveal` class: hidden until the
  row is hovered or holds keyboard focus, fading in and out over 150ms. Mouse
  focus alone never reveals them, so a clicked row does not keep its controls
  lit after the pointer leaves. No component ships its own opacity toggle.
- **Overlays render at the body.** Modals, popovers, hover inspectors and
  tooltips portal to `document.body` and carry the theme of the scope they
  opened from (`useTheme` + `themeStyle`). A `position: fixed` element inside
  a transformed, translated or filtered ancestor (the sidebar tab panel, a
  floating surface) positions itself relative to that ancestor: never mount a
  fixed panel inside pane content.
- **Tooltips always hide.** A hint closes on the anchor's leave event and on
  any pointer movement elsewhere, a drag or scroll start, or the pointer
  leaving the window; one of those always fires even when the anchor
  re-renders or turns inert under the pointer.
- **Popovers grow, never jump.** Hover inspectors measure their content and
  transition height and position, so a section that loads after the popover
  opens expands it smoothly. A popover that shifts its layout on load is a
  defect.
- **Primitives, not presets.** Anything a built-in section can do, a `sidebar.js`
  section can do with the same fields: `empty`, `headerActions`, `itemDefaults`,
  `itemOverrides`, `height`, `rowHeight`, and a source that exports `load`,
  `subscribe`, `action`, `move`, `drop`. A sidebar an agent writes looks like a
  built-in one without extra effort, and cannot break the chrome.

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
  `selection: "system"` resolves to the Work Light or Dark preset and
  follows operating-system changes live.
  ThemeProvider writes each resolved color as an inline CSS variable on
  `<html>`, sets `color-scheme`, and mirrors the appearance to
  `data-theme` for anything keyed on it.
- The Work Light and Dark presets in `theme.ts` and the paired
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

### 2026-09-11: Lean agent tool surface

Agent tools follow ADR 0133. Ordinary work uses native execution and
skills. Infrequent host operations use bounded capability discovery, retaining
live authorization and a small direct surface for user interaction. App creation
accepts initial presentation; cosmetic follow-up calls are not mandatory.

### 2026-09-11: Desktop tests own a separate desktop

Automated desktop tests run in a private Linux display locally and dedicated
macOS runners in CI (ADR 0129). They use normal native focus and rendering.
Testing must never interrupt the developer's keyboard, pointer, or clipboard.

- 2026-09-11: [ADR 0132](../../docs/decisions/0132-shared-contextual-sidebar-contributions.md)
  unifies built-in and custom sidebar collections, trees, row actions and context.
  Right-click and overflow menus are independently configurable. Contextual sections
  retain identity and distinguish empty content from loading and failed requests.

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
input. In-page pointers use the same `point_at` contract (null target clears pointers) as shell
pointers. Native computer access is an optional profile connector with the
existing queued consent UI; cancellation withdraws the request. See
[Computer use](docs/computer-use.md) and ADR 0112.

## Persistent project workspaces and dock

Project switching changes visibility without disposing work. A profile can
share its dock across projects, detach it above native windows, and place it
on either edge. Detaching is a session action: right-click the collapsed
bubble or the arrows to float the dock in its own window or return it, and
closing that window returns it. The `dockDetached` setting is only the state a
launch starts in; no dock interaction rewrites it. Project colors remain scoped to their chats and workspace.
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

### 2026-09-11: Session artifacts and review apps

Generated interactive results use the ordinary app surface. Temporary apps and
workflows share ownership and retention with their session, and can be reopened
from its Artifacts list. Closing a tab does not delete an artifact. Full app tabs
use the available viewport and refresh after successful rebuilds.

Review guides are generated apps using the shared review kit. Preserve Osama's
Overview, Guide, Changes and Discussion hierarchy and use host design tokens.
Real GitHub actions remain host-owned. See ADR 0124.

Review components are installed source from the code-review registry pack (ADR 0126).
Agents reuse project components first, then fetch the pack and adapt local source.
The desktop consumes the same pack; its components.read capability exposes registry items
and usage notes without changing the project. Temporary reviews retain their pack
files with the artifact. Future packs use the same registry model.
### 2026-09-10: Conversation consent and one search surface

[ADR 0123](../../docs/decisions/0123-desktop-consent-search-and-resource-links.md)
removes default project notes and duplicate file pickers. Sidebar searches open
scoped palettes from header buttons. "Ask agent" stays short and names the agent.
Consent appears as a durable question in its chat. Workflow and app links identify
and open their actual surfaces. Editable code derives syntax, background, gutters,
selection, cursor, diagnostics and widgets from the current app theme, with bundled
Shiki grammars. Never ship a preset editor background that ignores the app theme.

### 2026-09-11: Host-themed review packs

Installed review components use the host palette for syntax, change colors,
backgrounds and gutters by default, and inherit its color scheme inside the diff
shadow root. Typography and spacing follow the existing app tokens. Explicit code
palette preferences remain available in the desktop adapter. App mounts resend the
current theme on every guest load while theme switches preserve the guest's state.

## Dock placement and draft runtime controls (2026-09-11)

ADR 0127 adds placement without absolute positions. Open chats and their
bubble strip sit left, centered (default) or right (`dockPlacement`); the
collapsed bubble rests in a bottom corner (`dockSide`). There is no separate
handle: dragging the collapsed bubble picks its corner, and dragging the
expanded strip's arrows picks the placement. The arrows point at the corner
the strip collapses into and sit on that side of the strip. Dragging never
expands the dock or stores coordinates; release snaps with settling motion
that honors reduced motion. New and established chats share editable runtime controls; draft choices
apply only to that conversation. Explain unavailable controls beside the control.

Markdown hover previews use the app's rendered reading typography. Composer
surface chips and expanded group members use the shared resource inspector;
collapsed groups lead with their plural type and a separate count. Preview
content and behavior follow [chat state](docs/chat-state.md).

### 2026-09-11: Direct browser password imports on macOS

Profile settings offers direct password import per detected browser profile on
supported Macs, beside bookmark import. The action explains macOS authorization,
shows progress and added/skipped counts, and preserves existing passwords.
Other platforms retain CSV with a clear macOS support note. A prebuilt helper
ships only in macOS packages; see ADR 0130.

### 2026-09-11: Slash command composer

Repaired the [slash command experience](../../docs/desktop-slash-command-audit.md).
  The existing Enter-to-run and Tab-for-arguments interaction uses one send path.
  Command rows retain a fixed height, argument hints have a stable footer, and a
  native top-layer menu stays readable in narrow chats. Catalog loading, empty
  results, errors, retry, and keyboard selection are explicit.
  A T3 Code comparison further tightened command-name search, guarded selection
  against fresh input arriving before a render, and moved pointer activation to
  click release while retaining composer focus.

### 2026-09-11: Consent and collection lifecycle

[ADR 0134](../../docs/decisions/0134-consent-and-collection-lifecycle.md) binds deferred
consent to the approved definition. Sidebar trees own visible branch subscriptions,
hidden sections probe availability, and built-ins and widgets share session reads.

### 2026-09-12: Explicit orchestration ownership

Sidebar navigation owns its section composition and branch subscriptions. The
chat surface rail owns grouping, expansion, and resource inspection. Their parent
app and dock retain workspace and conversation orchestration. Desktop MCP policy
resolution and permission handling share one owner beneath the agent registry.
These boundaries preserve existing interactions while making subsequent changes
local to the capability they affect.

Signed macOS builds verify the browser-import helper's Developer ID identity,
matching app team, universal architectures, and safe version protocol. The manual
import smoke uses a disposable Chrome profile and a known test login; macOS
keeps control of the authentication and Keychain authorization prompts.


### 2026-09-14: Session workflow actions

Session monitors and timed wakeups use ordinary workflow enablements, with retained
source and run history. Chat displays compact attributed action entries. Agent,
workflow, run, originating chat, and child links use the workspace's resource
opening behavior. Turn completion and explicit work completion stay distinct.
Local and remote sessions share the same trigger and action contracts (ADR 0138).

### 2026-09-17: Local agent freedom and live sidebar sources

Local agents default to full access and edit real profile files. Executable sidebar
sources use lazy Bun processes and the shared native collection/tree presentation.
Initial loading, retained rows during refresh, recoverable errors and pending row
actions remain visible; arrivals use existing list motion. See ADR 0140.

### 2026-09-18: Profile history and shared browser import

One category-selection dialog serves onboarding and Settings. Onboarding returns
to its original actions and marks import complete. Results stay quiet, without
skipped-item reports. The History page groups reopenable surfaces by visit date;
its search control opens the same `history` palette mode. See ADR 0143.


### 2026-09-18: Consistent controls and browser setup

Dropdown menus and checkboxes use one app-owned stylesheet. Onboarding is a
vertical sequence of optional browser setup actions followed by project actions.
Default-browser status comes from the OS, shared with Settings (ADR 0144).
Async actions use the shared size-stable PendingButton with short label fades;
modal status space is reserved before loading so the action row stays in place.

### 2026-09-18: Uniform sidebar sections

[ADR 0147](../../docs/decisions/0147-uniform-sidebar-sections.md): one status
language drawn by the section chrome and one drag-and-drop model in the shared
tree, both available to custom sections through the source contract
(`move`, `drop`, `section.empty`). Bookmarks became an ordinary section over
its store; chat rows carry the tab's signals; section headers end with the
chevron; the tab panel reserves its scrollbar gutter.

### 2026-09-18: Page surfaces and sidebar scrolling

Settings follows the page-surface rules above: no in-page close, the search
button opens the palette's settings scope, the scroller spans the pane with a
sticky category nav inside it, every category has a heading, and GitHub CLI and
Connectors are separate `settings-card` blocks with their own catalog ids
(`github-cli`, `connectors`) so a deep link outlines one card. The PRs sidebar's
disconnected state is one title, one sentence, one button, and it stops polling
while the GitHub CLI connection is off. Virtualized trees only contain
overscroll while they can actually scroll, and bookmark lists scroll inside the
tree rather than inside a wrapper, so wheel input reaches the sidebar. The
profile avatar centers under the project icon and the name shares its x.

### 2026-09-19: Dialogs for forms, one button vocabulary, session-only detach

Every create/edit form and destructive confirm in Settings and Profile settings
opens the shared `Modal` instead of expanding inline; the theme color list is a
`Collapsible`. Rectangular actions take `button-primary`/`-secondary`/`-ghost`/
`-danger` from `styles.css`, so every "Add" in Settings carries the accent and
no confirm paints solid red with white text. A tooltip cancels on any press or
right-click of its anchor so it cannot surface over a context menu. Detaching
the dock is a session action from the bubble's or arrows' context menu; the
`dockDetached` preference is the launch default only and closing the detached
window never rewrites it. The detached window is a 124px strip, so its
context menus are native (`desktopApi.dockMenu`) and it draws no resting-spot
hints while dragging: the window itself moves, so hints inside it would
travel with the pointer. The bubble and the arrows carry no tooltips. A staged
minimize holds its exit pose until the entry reports "min", so dock-in never
replays between the two poses. Three more detached behaviours: the workspace
window reports its chat region (`dockRegion`) and the dock rests inside it
whenever a Work window is in front, so it never covers a sidebar; when the
window loses OS focus while the agent works, the chat lurks the same way it
does behind a tab. Seeing the screen behind the dock is the agent's job
through computer use, not a composer control.

### 2026-09-19: Apps that read your chats, and two chart-free dashboard parts

An app declares `catamorphic.access.sessions` in its package and the desktop
asks once, in place of the app, before a build that reads the profile's chats
mounts (`AppAccessConsent` in `screens/app-screen.tsx`, approval recorded per
project and app in `appAccessApprovals`). The card uses the settings-card
surface and one primary action; there is no "deny" button because closing the
tab is the refusal. The app kit gained `Stat` (label over a large tabular
number, optional toned detail) and `BarList` (horizontal bars scaled to the
largest value, accent at low chroma), so agents can show "how much of each"
without hand-rolled charts or literal colors; both are documented in the
`designing-apps` seed. See ADR 0148.

Apps built by agents now compose the kit before writing CSS: the
`designing-apps` seed opens its inventory with "reach for the kit before
CSS" and lists hand-rolled tiles, bars, tables and badges among the do-nots,
because an agent given a stat tile in the inventory still drew its own when
the rule was implicit.

Two sidebar fixes from filming an agent-authored section: a Lucide alias
name (`MessageCircleQuestion`) resolves through one shared resolver
(`lib/lucide-icon.ts`, used by rows, tabs, inline actions and the palette)
that accepts only members of the icon table, so an unknown name or a
non-icon export such as `Icon` falls back to a dot, never text and never a
crash; and hiding an item hides its
subtree, since hiding only the `.catamorphic` row hoisted the workspace's
folders into a project files section. Agents also finish an app with the
host's `build_app` and an `app:<name>` link; a local `bun run build` alone
leaves "no successful build yet" on the app's screen.

An app runs its workflows where the person viewing it may: the app-narrowed
identity keeps the viewer's execution reach in the project, so the desktop
user's apps run on "This Mac" without any grant.

A preview app calls the project as it is on this machine: its workflow calls
read the dev checkout's working tree, the same files the preview was
compiled from (a build never commits, and the turn checkpoint lands after
the agent has already opened the app). Only published apps run the published
ref. Before this, a freshly built preview answered "Workflow not found" for a
workflow the agent had just written, because calls still resolved the
project's initial published commit.

### 2026-09-19: Bubble clicks follow the open modifiers

A dock bubble opens its chat the way every other resource opens: a plain
click floats it, ⌘-click opens it as a workspace tab, ⌘⇧-click opens it as a
tab to the side of what you are reading (`openModeFromEvent`, the same
mapping rows and links use). Before this, bubbles only toggled the floating
panel, so reaching "chat beside the page" meant floating first and then
"Open as tab" plus a split.

### 2026-09-19: Host notices stay out of replies

Local agents load the person's own CLI configuration, which can carry plugin
MCP servers the desktop cannot authorize. The harness reports those at
startup, and the assistant used to relay the notice unprompted ("the Slack
connector needs authorization") in the middle of an unrelated answer. The
workspace prompt now names those reports as host notices: connectors are
managed in Settings, and the assistant mentions one only when the person asks
about it or asks to use it.

## Work identity (2026-09-18)

The desktop product is Work, powered by the Catamorphic framework. Its icon is
the orange W in `build/icon.svg`, shared with Work mobile and work.software.
Theme presets are Work Dark and Work Light; the existing palette and motion
contract continue to apply. Packaging, invitations and storage identity follow
[ADR 0146](../../docs/decisions/0146-work-application-identity.md).

### 2026-09-20: Review fixes on the app-access branch

"Read" means read: the sessions ref an app gains (ADR 0148) lists and reads
the viewer's chats and can change none of them; every session mutation asks
for an agent ref, and the session-actions door settles access before it
records an action. The consent card waits until both the app list and the
profile's answers are known, so an approved app never flashes the question
and an unanswered one never runs early. Apps driven over the MCP door take
the same identity path as the iframe (execution reach and session access
included). One Lucide resolver serves rows, tabs, inline actions and the
palette, and it accepts only members of the icon table: an agent writing
`icon: "Icon"` gets a dot, not a crashed sidebar.

### 2026-09-20: Lurking follows the person, not the layout

The floating chat folds to its strip (lurks) only on the person's own
signals: a click or key that moved focus outside it, or a pointer that
actually moved away. Chromium re-hit-tests after layout changes and fires
the same leave and focus events without any input, so a sidebar section
landing under a parked pointer, a panel sliding, or a row claiming focus as
it mounts used to fold the chat mid-reply (the film take lost its streamed
text that way). `lib/dock-attention.ts` holds the two rules: a leave counts
when the pointer is outside the box and moved within 400 ms; focus outside
counts when input preceded it within 400 ms. A parked pointer the dock slid
away from is settled by the next real move.

The strip itself shows what the agent is doing: its one line is the
timeline's activity row (spinner, "Working…", the tool in progress), never
whichever slice of the transcript happens to fit in fifty pixels. The film
take had shown a lurked chat with only the person's own message in it.

### 2026-09-21: Sign-in never goes dark, and popups stay popups

First real-use notes from running Work as the default browser. Three rules
came out of one broken Claude sign-in:

- **The wizard stays until its flow ends.** A sign-in creates its agent
  before it finishes, and "an agent exists" used to close the setup wizard
  on the spot, leaving a silent wait and then a terminal from nowhere. The
  wizard now reports being mid-flow (`onEngagedChange`) and the host leaves
  it alone until `onDone`. A terminal sign-in finishes the wizard by itself
  when the credentials land; Continue remains the manual way out.
- **A wait says what it is.** Harness executables arrive on first use
  (Claude Code is ~200 MB). The sign-in button shows the download
  ("Downloading… 42%") rather than sitting on "Starting…". Both actions of
  a two-choice step are real buttons: the secondary one is outlined, same
  height as the primary, and both animate hover and press over 150 ms.
- **A scripted popup is a window, not a tab.** Pages that call `window.open`
  with window features (Google sign-in, most OAuth and payment popups) hand
  their result back through `window.opener`. Re-homing them as workspace
  tabs produced a blank page and a failed sign-in. They now open as child
  windows in the opener's session (`main/browser-popups.ts`); ordinary
  `target=_blank` links still become tabs, and whatever a popup opens in
  turn becomes a tab too.

The agent wizard names the product people hold an account with (Claude,
ChatGPT), and that is a new agent's default name. Harness names (Claude
Code, Codex) stay where the harness itself is the subject.

The right sidebar starts collapsed (`rightSidebarOpen` defaults to false).
A first launch shows the work, not the chrome around it; the companion is
one click away and the choice is remembered from then on.

More from the same day of daily use:

- **A page that closes itself takes its tab with it.** Sign-in hand-offs
  call `window.close()` when done. Ignoring the guest's `close` event left
  a dead, blank view that kept focus and swallowed every shortcut, Cmd+W
  included. The tab now closes, as it would in Chrome.
- **The chat region is found whenever it appears.** The dock host looked
  the region up once; on a fresh project it was not mounted yet, so chats
  were laid out over the whole window and a tab chat's status controls sat
  under the tab bar. The host now waits for the region and follows
  remounts.
- **No empty pinned area.** With nothing pinned the pinned bookmarks area
  is absent, not an empty state. It returns only as a drop target while
  something is being dragged; "Pin across projects" works regardless.
- **A folder moves what is below it.** Tree rows are absolutely placed, so
  expanding or collapsing a folder used to snap every later row (and the
  tree's height) while only the children faded. Row position and tree
  height now ease over 200 ms (`packages/app/src/ui/tree.tsx`), off under
  reduced motion.

### 2026-09-21: A turn is work, then an answer

An agent turn reaches the chat as a run of assistant messages: a note each
time the agent pauses between tool calls (with the steps that led to it),
and last the answer. People asked for three "modes" of showing that. Modes
multiply; the turn already has two phases, so there are two independent
choices instead (Settings → Workspace → Chat dock):

- **While the agent works** (`chatWorkLive`): every note, or only the
  latest, each new note replacing the one before.
- **Once it has answered** (`chatWorkSettled`): notes kept in place, or
  folded into steps.

The default is `latest`+`collapse`: one note at a time while the agent
works, then only the answer, with the notes one click away under its steps.
The three requested behaviours are `all`+`keep` (how it used to read),
`all`+`collapse`, and `latest`+`collapse`; the fourth combination comes
free. A folded note is not a new kind of thing: it is a row of the same
steps disclosure tool calls already use, in true order (a note follows its
own steps), expandable to its Markdown, still addressable by message id.
Nothing is dropped, only moved one click away. The grouping is a pure
function (`lib/turn-groups.ts`); a failed turn's error card and the note
before it always stay in place.

Steps are chrome around the conversation, not part of its text: the steps
block is `select-none`, so a drag across several replies selects the prose
and skips the rows. An opened payload is content again and selectable.
Every reply has a hover Copy beside Fork; it copies the Markdown source,
which is what pastes well elsewhere.

**Bookmarks learn their icon from a visit.** A row shows its stored icon,
else guesses `/favicon.ico`. Imported and synced bookmarks arrive with no
icon, and most sites declare theirs in markup, so the guess left a globe
that no visit ever fixed (the real icon only went to history). A page's
reported icon now reaches bookmarks of that page (scheme, `www.`, trailing
slash and fragment ignored), and same-site bookmarks that still have none.

### 2026-09-18: Observed Git changes

The Changes section subscribes to the checkout being viewed. Native file events
trigger debounced Git reads, with a slow reconciliation for missed events. Hidden
consumers release their watches; returning refreshes immediately. Refresh retains
existing rows and disclosure state. Linux watches only the directories Git
reports on, never ignored trees; a cooldown after each scan keeps continuous
agent edits from scanning more than about a fifth of the time. A Changes
section hidden for being empty keeps observing, so the next edit brings it
back (it used to drop its subscription with the section and stay gone). See [ADR 0150](../../docs/decisions/0149-observed-git-overviews.md)
and the [measurement report](docs/performance.md#changes-subscriptions).

### 2026-09-22: A site has one dialog

A page asked for the microphone and nothing happened: the browser session
answered permission requests from a fixed list, with no prompt and no
place to change the answer. Chrome's site settings are the model people
know, so that is the vocabulary (ADR 0150): per site, each capability is
Ask, Allow or Block; a page's request prompts once; Allow and Block are
remembered, "Allow this time" and dismissing are not.

There is one dialog for a site, wherever it opens from: the gear beside
the bookmark star, the palette's "Site settings" (offered while a browser
tab is focused), a row on the Sites page, or the page's own request. It
is centered like every other modal here, not a bubble hanging off the
address bar. When a request is pending the question leads and the
permissions and site data fold below it; opened by hand, everything is
laid out. Site data is the cookies and storage the site keeps in the
profile, deleted behind a confirm; permissions survive a delete, as in
Chrome. The Sites page lists every site with a choice, a visit or cookies,
customized sites first, and its rows open the same dialog.

**Sharing a screen has a picker, not a prompt.** `getDisplayMedia` used to
fail outright. Now it opens "Choose what to share", Chrome's three panes
(this window's tabs, windows, entire screen) in the same centered modal
frame as everything else; a shared tab brings its audio when the site asks
for it. Cancel refuses the
request the way Chrome does. Tabs list at once; windows and screens follow
when the OS answers, and screens are still offered when macOS withholds
its list. The Electron bump to 44 (Chromium 152) that came with this also
ends Gmail's "browser no longer supported" banner: Google admits only the
two newest Chrome majors, and the app's user agent now reads as a clean
Chrome string (a prerelease version tail used to leak into it).
