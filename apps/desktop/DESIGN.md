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

Project capabilities live in `.work/`, including the independent Bun
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
the company host; holders of `program:publish` approve or apply the reviewed
revision with their own repository identity. Worktrees serve independent repository work, not
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
Open and close use paired 150ms opacity/translation on the standard easing.
A checkbox is a 16px square: a faint fill with a neutral 1.5px inset edge
when off (`--color-fg` at 40% dark, 50% light: never white, and at least 3:1
against the surface), a solid accent with no edge when on. Its 10px mark sits on whole pixels, draws left
to right over 150ms and fades out when unchecked; pressing the box sinks it
to 88%. Screens never size or color a checkbox themselves (design lint).
Respect reduced motion. Disabled
controls retain their label and explain why. A picker owns Escape before its
dialog; selecting a value or dismissing it restores the trigger's focus.

Verify pointer and keyboard selection, nested Escape, disabled/indeterminate
checkboxes, light/dark themes, long labels, narrow layouts and reduced motion.
`e2e/browser-import.e2e.ts` covers the shared import controls and onboarding.
External website and user-app content retain their own UI; this contract governs
the desktop shell, including its registry components and document task lists.

## Switches

A switch turns something on or off **at once**: an extension, Developer mode.
A checkbox is a choice the person confirms later (a form, a dialog's Save) or
one item of a selection. Never a switch inside a form that has a Save button,
never a checkbox for a setting that applies the moment it changes.

A switch is the same semantic checkbox with `role="switch"` and `aria-checked`
mirroring `checked`: `<input type="checkbox" role="switch" aria-checked={on}
checked={on}>`, drawn only by
[`form-controls.css`](src/renderer/form-controls.css). No `<button>` or `<div>`
switches and no switch library (design lint). Its name says what it controls,
never the action: a visible label beside it ("Developer mode", text before the
switch), or an `aria-label` naming the thing when its card or row already shows
it (`aria-label={extension.name}`). Never "Turn on X" or "On": assistive
technology already reads the state.

It is a 28x16 pill in the checkbox's colors: off, the faint fill with the
neutral 1.5px inset edge and a muted thumb; on, a solid accent with a white
thumb and a faint shadow (in both themes, as macOS draws one). The 12px thumb slides 12px over 150ms on the standard
easing and stretches to 14px while pressed; the pill itself never scales.
Disabled, reduced motion and focus follow the checkbox (50% opacity with the
reason shown, no transition, the shared focus ring). Screens never size, color
or space a switch's insides; a margin beside it is fine. Clicking its label
toggles it, and Space toggles it from the keyboard (it is a checkbox).

It moves the moment it is toggled and stays enabled meanwhile; if the change
fails it moves back and its card or row says why. Verify both themes, keyboard
toggling, a disabled switch with its reason, and a failing change.

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

## Focus rings

One ring everywhere (ADR 0168): 2px of the accent, drawn as
`outline: var(--focus-ring-width) var(--focus-ring-style) var(--color-accent)`.
It sits outside a standalone control (`--focus-ring-offset`, 1px) and inside
a row, tile, menu item, scroll container or anything stacked or clipped
(`--focus-ring-inset`, -1px, which covers a 1px border instead of doubling
it). Use the global `:focus-visible` rule or `.focus-ring-inset`; sidebar
rows and tree items already draw the inset ring on their rounded box. Text
fields keep their border-and-glow focus instead.

- **The keyboard leads.** `lib/focus-modality.ts` marks the root `pointer`
  after a pointer press and `keyboard` after Tab, arrows, Home/End,
  PageUp/PageDown, F6 or the context-menu key. While the pointer leads, rings
  are off, so Escape or Enter after a click never lights the focused control.
  Row previews open on focus only when the keyboard leads.
- **Rings appear at once.** Every element rests with the accent as its
  outline color, so a transition that includes outline color never fades a
  ring in from the text color.
- **No private recipes.** `focus-visible:outline-*` utilities and literal
  `outline: Npx solid` rings fail design lint.

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

A sidebar slides with a 200 ms transform the moment it is toggled (closing
from open, 100 ms after its items start to leave), and the
content beside it settles after it stops: a 300 ms linear view-transition
fade in place from its old layout to its new one (ADR 0200). The content resizes once per
toggle, never while anything moves. New motion beside a page, terminal,
editor or app frame moves over it rather than animating its size.

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
| `content-fade-out` / `content-fade-in` (content settling beside a still sidebar, view transition: the old snapshot fades where it was, the new one fades in) | 300ms, linear (a sanctioned exception) | each other (the old snapshot leaves as the new one arrives) |
| `dock-float` / `dock-rail` groups (a floating chat and the bubble strip gliding while the content settles, view transition) | 200ms | within the content's 300ms fade; a chat tab (`dock-tab`) fades in place with `content-fade-out` / `content-fade-in` from its own place |
| `bubble-ask` (agent question arrival) | 280ms | — (one-shot nudge on a persistent bubble; no exit to pair) |
| `input-recall-{up,down}-{a,b}` (composer ↑/↓ history) | 150ms | — (transform-only directional content signal; paired names replay rapid same-direction recalls without a classless frame) |
| `activity-leave` / `activity-arrive` (agent activity line swap) | 150ms / 200ms | — (one beat of the working pulse carries a content swap on a persistent line: the old text dims up and away, the new rises in, then `animate-pulse` resumes) |
| sidebar leave (Web Animations in `lib/sidebar-leave.ts`: a closing sidebar's rows leave, each drawing a thread behind it; the panel's slide waits 100ms for them) | 160ms | its own reverse when the sidebar opens mid-close; opening shows the items in place as before (a sanctioned exception) |
| `title-change` (rename flash) | 1200ms | **sanctioned exception** — the
  one decorative-adjacent signal (see design log 2026-07-31); allowlisted in
  the test's `DURATION_EXCEPTIONS` |
| `veil-touch` (a press on an agent-held surface) | 760ms | **sanctioned exception**: one-shot answer to a refused press; the sheet appears, gives, and clears (design log 2026-10-09) |

### Sanctioned exceptions

- `animate-spin` / `animate-pulse`: indeterminate progress may loop.
- `title-change` (1200ms): a deliberate noticed-but-calm rename signal.
- `veil-touch` (760ms): a press on a held surface shows the veil, which
  gives where it was touched and clears; shorter, the wobble reads as a
  flicker.
- `content-fade-out` / `content-fade-in` (rule 1): linear, over 300ms. A
  cross-fade in place moves nothing, and the standard curve does most of
  an opacity change in its first quarter, so a fade on it reads as a snap.
- Sidebar close (rule 4): closing from open runs 100ms longer than opening,
  since the items leave before the panel slides; the slide itself is 200ms
  both ways. Not an `.animate-*` class, so the test allowlist doesn't
  carry it.

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
  when empty (`section.empty` in `workspace.js` replaces it), and the error with
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
  focus rings sit inside the row (the inset ring, above siblings) so stacked
  rows never cover or clip them.
- **Nothing in the sidebar snaps.** `Collapsible` tweens to its content's
  height whenever that changes (skeleton to rows, empty sentence to a list),
  following exactly while something inside animates its own height. Sections
  hidden when empty collapse before they hide and open when they fill; the
  pinned area and the library group open and close the same way, and a group
  carries its own bottom spacing so its gap leaves with it. A removed tree row
  leaves the layout at once and fades where it stood while the rows below
  slide. The dragged row dims; a dropped row fades into its new slot as its
  neighbours slide. The insertion line glides between slots and never leaves
  the viewport. A tree whose rows fit never scrolls, so no scrollbar flashes
  while it grows.
- **Drags reveal only what accepts them.** The pinned area opens for drags it
  could pin and stays open until a pin dropped into it arrives. Hover
  previews close when a drag starts.
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
- **Pointer and focus hold an inspector independently.** A hover inspector
  stays open while the pointer or keyboard focus rests on its trigger or its
  panel, so the pointer passing over and away never closes what focus holds.
  Focus from a click, or returning to the trigger after Escape, leaves the
  inspector to the pointer.
- **Primitives, not presets.** Anything a built-in section can do, a `workspace.js`
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
### 2026-10-06: Codex signs in on your own machines

Remote environment's Sign-ins section now says plainly where each harness
runs on a person's behalf (ADR 0213): Claude Code on their own
subscription only on this computer, and on the server through the
organization's model connection. Below it, Your machines lists the
machines that run only their work, each online or not and signed in to
Codex or not. Sign in to Codex opens a small dialog with Codex's own
device code steps: the sign-in page (a Work browser tab, with the link
shown too) and the one-time code, large and copyable. The token stays on
the machine; the desktop only ever sees the code. The dialog checks every
two seconds, closing it cancels a waiting attempt, and an answer to an
attempt closed since never touches it. Sign out asks in place, like
clearing a secret. A server without the route hides the list.

### 2026-10-06: Work beside a server chat

A chat that runs on the project's server now offers Open terminal and Open
preview in its menu (dock bubble and sidebar row) and in the palette (ADR
0209). The terminal is an ordinary terminal tab named "Terminal · <chat>":
its session in the main process is a remote backend beside the local PTYs,
so the emulator, keys, scrollback and Cmd+Shift+T behave as they do for a
local shell. Closing the tab closes the shell. When the shell itself exits
the tab closes; when the workspace went away the tab stays and says so.
Open preview asks for a port (the chat's last one filled in) and opens a
browser tab on that preview's own loopback host (`p-<id>.localhost`,
ADR 0211), so a dev server's `/assets/...` URLs and its cookies work as on
the person's own machine and stay that preview's; the address stays the
same across restarts, so a restored tab still opens. The
server's own refusals (nothing listens, the workspace is not running) show
as a plain page in the tab.

### 2026-10-06: Chrome extensions install from the store and live in the toolbar

The browser runs Chrome extensions (ADR 0203). "Add to Chrome" on the
Chrome Web Store opens Work's own dialog: the extension's icon, its name
as a question, and what it can do in Chrome's words, with Cancel and Add
extension. The same centered dialog asks before an extension gets more
access, before an update that wants more is applied, and before an
extension is removed. After an install a card under the puzzle button
says where the extension lives and offers to pin it.

The toolbar follows Chrome: pinned extensions' buttons sit after the site
settings gear, with their badge in the corner and a right-click menu
(Options, Pin, Remove, Manage, and the extension's own items). The puzzle
button lists every extension with a pin toggle, Manage extensions and the
Chrome Web Store; it is absent while a profile has none. A popup hangs
under its button, right edges aligned, sized by its page, and leaves on
Escape, a click elsewhere or focus moving away. A side panel opens beside
the tab it was asked for, with the extension's name and a close button,
and resizes from its left edge. A tab an extension drives through the
debugger shows a bar naming it, with Stop.

The Extensions page is a page surface: one card per extension. Its own
actions sit top right, as in Chrome: a pin (filled in the accent when the
extension is in the toolbar, the same pin as the puzzle menu's), a trash
button to remove it (red on hover, confirmed in a dialog) and its
[switch](#switches); options, review and Details (what it can do,
shortcuts, id, source) sit below. Developer mode is a switch in the
header and adds Load unpacked and Update. `chrome://extensions` typed in
the address bar opens it.

### 2026-10-04: Bookmarks read and write their file like every other config file

`bookmarks.json` was the one config file the app kept in memory and wrote
back whole, so an edit made outside the app (an agent adding a bookmark)
was lost when an in-app change (a page's favicon, a drag) landed before
the next one-second poll. Bookmarks now use `ConfigFile`, as prefs,
shortcuts and the theme do: every read and change goes to the file, a
change writes atomically, and an invalid file keeps the last valid
bookmarks, is named in Settings, and is never written over. The poll only
tells windows what changed.

### 2026-10-04: The palette goes to open tabs first; the dock fits its screen edge

Typing in the palette now finds open tabs, and a tab ranks above a bookmark
or a page in history with the same match: switching back is the likely
intent. An open tab stands in for its page, bookmark, chat or file, so each
destination is one row; app surfaces keep their own row, which already
brings their tab forward. The tab in front is not offered. `tabs` + Space
lists every open tab in strip order (ADR 0186). Imported bookmarks are now
searched too, so a saved page ranks above the same page in history; they
stay out of the empty palette, as do open tabs.

The downloads popover opens toward the middle of the screen when the strip
rests at a side, instead of hanging past the window's edge, and the
detached dock's window grows while it is open, as it does for dialogs.
Like a chat bubble, the downloads bubble shows a close control on hover
once nothing is downloading; closed, it stays away until the next download.
Dragging the strip over a page or app frame no longer stalls: while the
handle is held, a shield over the window keeps the frame from taking the
pointer, so the middle resting spot lights and takes the drop.

### 2026-10-01: Pages load like Chrome's; unused tabs sleep

Pages loaded slower than in Chrome, and Meet sometimes showed its icon
names ("mic", "videocam") in place of icons. The caches worked; the app was
in the way. The Chrome-brand header rewrite put every request through the
main process, which the embedded server keeps busy, and a JIT workaround
slowed JavaScript in every page. The rewrite now covers documents and
fetch requests only, and the workaround is gone (ADR 0194).

Browser tabs out of sight for an hour (Settings > Workspace > Browser:
15 minutes to 2 hours, or never) sleep, as with Chrome's Memory Saver. The
page unloads and comes back where it was, scroll position and form values
included. Sound, the camera or microphone, a tab share, unsent typed text
and agent work keep a page awake. A sleeping tab's icon fades behind a
dashed ring in the tab strip and the sidebar, and its hover card says it is
asleep. A reopened workspace loads only the tabs on screen.

### 2026-09-30: On Linux the detached dock takes the shape of what it draws

Electron forwards pointer moves to a click-through window only on macOS and
Windows. On Linux the dock lost the pointer the moment it let clicks through,
took them back on the leave, and let them through again on the next move,
dozens of times a second while the pointer rested over its empty space.
There the dock no longer toggles click-through: its window takes the shape of
what it draws (strip, open or lurking chat, a chat still animating out,
dialogs, tooltips), re-measured on the frame after anything changes, when a
drawn surface resizes or the pointer arrives over it, and on every frame while
something moves. Clicks on its empty space reach the screen behind it, as on
macOS, and nothing flickers. The main process decides the mode once
(`shared/dock-clicks.ts`), hands it to the dock window, and answers whether
each change was applied, so the renderer never assumes it.

Limits: the shape includes the visible core of a shadow (half its blur plus
its spread, where shadow-2xl has faded under 4%); the fainter outer half is
clipped, because the full extent would cover the whole margin around an open
chat. On Wayland, where Electron cannot shape or pass clicks through a
window, the dock keeps every click inside its window, empty space included.

### 2026-09-30: The palette highlight follows the chosen row

The highlight follows the row the keyboard or a moving pointer chose, through
late re-ranks; a new query or mode returns it to the top result.

### 2026-09-29: Work reads as it happens

People watching a long turn saw one sentence change every few minutes,
with the steps behind a closed "N steps" line and nothing for the call in
flight: a two-minute test run and a hung command looked the same. The
turn now reads while it runs:

- **Every note by default.** `chatWorkLive` defaults to `all`, so the
  agent talks through the work; `latest` stays a choice.
- **Steps open while live.** A running turn's steps disclosures are open
  and close once it has answered. Opening or closing one by hand sticks.
  A lone step is its own row, never a "1 step" line to open.
- **The call in flight shows.** The in-progress message's steps (those
  since the latest note) render below the notes, with no prose of their
  own. A call runs until its result arrives; harnesses report that end
  (Claude Code and the built-in agent now do, Codex did). Core stamps
  each event's arrival (`at`) and each step's `endedAt`, so steps show
  their duration from a second up, and a running step counts.
- **The clock and the silence.** The activity line counts from the
  turn's start and, after 30 seconds without progress while the agent is
  working, says "No updates for 45s".
- **Notes are prose.** A note folded into steps reads in the body text
  colour and size, not as a grey tool row.
- **An interruption says what it stopped.** The interrupted turn keeps
  its steps and says which step was running, for how long, and which
  files it left changed.
- **Nothing snaps.** Showing every note made settling the biggest jump in
  the chat: the notes left all at once. Notes that fold now stay for one
  fold-away animation (`animate-fold-away`), keyed by the note, because a
  settle can land over two renders. A lone step keeps the list's
  structure, so a second step grows the line to open it in. The clock,
  step times, the quiet hint and the interruption summary fade in. The
  quiet hint is muted text: a long test run is quiet too, so it is not
  shown as a warning.

### 2026-09-28: Your own sign-ins and files follow you to the server

A linked project's sessions on a Work server can use the person's own
Claude Code and Codex sign-ins and files the repository lacks, such as
`.env` (ADR 0184). One private file says what goes:
`.work/personal/environment.json`, inside the Git-excluded personal folder,
so neither it nor the files it lists are ever committed. People edit it
through Remote environment (the sidebar's Server section, or "Remote
environment settings" in the palette); agents edit it with ordinary file
tools, taught by the `remote-environment` host skill. The dialog only
edits that file: Add files picks inside the project folder, Remove and the
sign-in checkboxes rewrite it, and Edit config opens it in the editor.

The desktop reads logins itself (Keychain, then `~/.claude/.credentials.json`;
`~/.codex/auth.json`), strips every refresh token, and sends the set when a
login, the config or a listed file changes, every two minutes, and on focus.
Only this computer's CLIs ever refresh a login. When the server says a copy
in use expires within the hour, Codex refreshes through its app-server
(`account/read` with `refreshToken`, no model request). Claude Code has no
refresh command (`claude auth status` only reads cached account data) and
refreshes only within five minutes of expiry, so the desktop waits for that
window and then makes one Haiku request with no tools, hooks or MCP
servers. A secret-free `.work/personal/environment-status.json` lets agents
check what reached the server without asking the person.
### 2026-09-26: Opening other apps asks where you can see it; layout motion stays smooth over pages

A page that wants to open another app now names it ("github.com wants to
open Slack"). If Work is in the background, the requesting tab comes forward
and the Dock icon bounces until the question is answered, and the question
is withdrawn when the tab moves to another page: a late answer never
launches an app for a page that is gone (ADR 0150).

Opening the sidebar over a web page stuttered because the page, rendered in
its own process, resized on every frame. Heavy content (pages, terminals,
the code editor, app frames) now holds one width through a layout transition
and resizes once ([performance](docs/performance.md)). Apps agents build get
the same focus rings, checkboxes, select menu and collapsible motion as the
shell (ADR 0168).

### 2026-09-26: One focus ring, simple checkboxes, a sidebar that moves

Right-clicking a sidebar row and pressing Escape lit the row with a white
ring that turned orange. Two causes: Chromium shows `:focus-visible` after any
key press, and the row's color transition faded the ring in from the text
color. Rings now follow the keyboard (Tab and arrows turn them on, a click
turns them off) and appear at once, and every ring comes from one set of
tokens instead of a dozen utilities (ADR 0168).

Checkboxes lost their white border and the mark that drifted as it scaled:
a neutral edge when off, a solid accent with no edge when on, a mark that
draws itself and a small press.

The sidebar framework stopped snapping. Unpinning the last item used to
drop the pinned area in one frame and every drag in the window popped it
open; empty sections vanished and reappeared; removed rows faded, paused,
then closed the gap; dropped rows glided in from where they started. The
shared `Collapsible` and `Tree` now carry all of that motion, so every
section inherits it, and vertical workspace tabs use the shared drag model.

### 2026-09-24: Permissions replace the builder flag

A remote project used to split people into members and builders, and a
builder could do everything: edit, publish, set secrets, read every chat.
The desktop now reads what the person actually holds from `GET /me`
(ADR 0158). Holding `program:write` is what the builder experience was: the
project opens as a Git checkout of the program with its files and branches.
Approving and applying proposals needs `program:publish`, so someone can
edit without shipping. Inviting and managing members needs
`memberships:write`. Sidebar items and starting actions target `when: { permissions }`; there is
no builder switch left to match.

Turning a workflow on shows what it asks to do in plain words: "Post into
anyone's chat", not `sessions:write`. Only someone holding every listed
permission can confirm. When an automation stops because its owner lost a
permission, its status says so in a sentence instead of a reason code.

### 2026-09-23: The chat names its model and moves with its work

A chat with no pinned model said **Automatic**, which answered nothing:
the harness decides, and nobody knew what it would pick. The chat now asks
the harness before the first message. Claude Code reports the model its
effective settings select for that folder (env, user, project and local
settings, then the account default). Codex reports its config layers'
model, else its catalog default. The built-in agent names its resolved
OpenRouter pick. The inspector shows that name with a faint **default**
tag, and the palette's default row carries it as detail. When a harness
cannot say, the row names who decides (**Claude Code default**) instead
of guessing. Each answer spawns the harness CLI, so main caches it for a
minute per agent and folder, and chats ask only while nothing pins a model.

The activity line breathes while the agent works. A new activity now rides
one beat of that pulse: the old text dims up and away, the new text rises
in, and the breathing resumes. Activities that arrive mid-beat collapse
into the latest one. The line no longer blinks out between sending and the
turn starting: a send stays "sending" until the session shows what the
host did with it.

Floating and lurking chats drop the agent icon beside the title. The strip
is a glance; the title and the activity are what it is for.

### 2026-09-23: Passwords work like Chrome's

Saving passwords felt broken. Any click in a form offered to save, even
a password the site had just rejected. The offer vanished when a sign-in
redirected to another subdomain. Sign-ins that used a plain button were
never seen, and filling was a bar across the page. Now a sign-in is
offered only once it lands (ADR 0151): the next page has no password
form, or the form goes away. **Update password?** appears when a saved
password changed, and nothing appears when it didn't. A username from an
email-first step carries into the password step.

Clicking a login field lists the saved accounts under it, like Chrome's
autofill dropdown. It uses the menu surface and paired pop motion, and
flips above the field when there is no room below. The page keeps focus,
so arrows, Enter and Escape work from the field. A new-password field
offers a strong password as soon as it takes focus; using it fills the
confirm field too. When the form goes out, the password saves itself and
the tab shows **Password saved** with **Update**, which opens the editor
for the username and a note.

The save, update and saved states share one card in the page's top-right
corner, where Chrome's key bubble opens. Unlike the site dialog it is not
centered: it answers a sign-in in progress and must not take focus from
the page. Password dots are drawn, not typed: font bullets look like
specks at list sizes. Passwords now have their own page, like Sites,
where each login reveals its password and note in place. Profile
settings counts them and links there.

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
subtree, since hiding only the `.work` row hoisted the workspace's
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
  latest, each new note replacing the one before (later also Notes only,
  see 2026-10-08).
- **Once it has answered** (`chatWorkSettled`): notes kept in place, or
  folded into steps.

The default was `latest`+`collapse` (now `all`+`collapse`, see
2026-09-29): one note at a time while the agent works, then only the
answer, with the notes one click away under its steps.
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

**An update restart is a quit.** Restart-to-update closed every window as
Electron asks, but a workspace window only hides on close unless a quit is
under way, so the app never left: "Preparing to restart" stayed on screen,
the installer never ran, and every launch downloaded the same update again.
Electron announces `before-quit-for-update` before closing windows; that is
now a quit for the windows too. The installer relaunches the app behind
other windows, so the quitting instance leaves a marker and the relaunch
brings its window to the front. Page notifications also go through the
main process now, with the site under the title as Chrome shows it and
the site's own notification choice deciding; a page reads the real
default / granted / denied state instead of Electron's always-granted.

### 2026-09-23: The trackpad turns pages

Two-finger swipes are how people go back in Chrome, and they reached the
page here as plain horizontal scrolling. The guest preload now does what
Chrome does: horizontal pixel deltas that nothing under the pointer can
consume accumulate toward a threshold, an arrow at the edge grows with
the gesture and fills when crossing it will navigate, and a change of
direction or a pause starts over. A page that can still scroll sideways
keeps the gesture. macOS three-finger swipes arrive as the window's own
event and go the same way. No setting: the gesture is the platform's.

### 2026-09-23: The agent sees what you see, and talks like you do

Asked "What is this thing?" over the Work website, an agent described the
empty project's config folder and first commit. The page was in its context,
but only as the last line of a tab list pasted into the person's own message,
behind a wall of workflow mechanics every chat carried. Now each turn arrives
with context beside the message, never in it (ADR 0152):

- what the person is looking at comes first, with a short passive look
  inside it (a page's opening text and description, an editor selection, a
  terminal's latest output);
- where the chat sits: floating over the view, beside it in a split, or
  full window, when "this" means what they looked at just before;
- who they are, their role and its description, and where commands run.

The standing prompt is short and general: most requests are not about code;
answer about the screen first; match the person's role and fluency; keep
files, Git and internals out of answers for non-technical people; load the
workflow or app skills only when the work needs them. Building an automation
now reads as "every weekday at 9, a reminder lands in this chat; late if this
Mac is off", not as a watcher id.

### 2026-09-23: Downloads live in the dock

A download used to end in an OS save dialog and then silence. Now it
saves to the downloads folder without a question (ADR 0153), and the dock,
where the app's own activity already lives, grows a download button
beside the chat bubbles: a ring fills while bytes arrive, a tick marks a
finished file nobody has looked at, and the bubble shows the last few
with a way to the Downloads page. The page lists everything by day, with
pause, cancel, Show in Finder, Remove from list, and the usual open
gestures. Opening a file means opening it in Work when Work can show it
(what a browser tab renders, plus plain text); anything else is revealed
in the file manager rather than handed to whatever app the OS would pick.

### 2026-09-23: History belongs to the profile

History was stored per profile but shaped per project: anything that was
not a web page had to be a project's resource, so a downloaded file
opened as a tab became a "project file" by absolute path and the
no-project window recorded nothing. Now the log is the profile's (ADR
0154): a page, a file on this machine, or a project's resource, each
naming the project it was opened in when there was one. The page grows a
scope menu in its header, "All projects" or one project, a facet rather
than a filter field, so search stays with the palette. A loose file
reopens as it opened, as a browser tab.

### 2026-09-23: The detached dock lets the screen through

In its own window the dock is transparent except for what it draws, and
it hit-tests under the pointer to let clicks through wherever nothing is
drawn. The app root filled that window and counted as something drawn,
so the margins around an open chat swallowed every click on the
workspace behind them, and since those clicks never landed, the window
never lost focus and the chat never lurked. The root is now
pointer-transparent in the dock surface (content opts back in, as it
already does over the workspace), and the hit test repeats when the
window resizes under a parked pointer. The e2e clicks with the OS
pointer, so the click lands wherever the OS says it does.

The same window also moved a few pixels whenever a bubble opened or
collapsed a chat: clicking the dock focuses the dock, and its resting
area was read from the focused window, so with the dock in front it
fell back to the display's edge instead of the workspace's chat region.
The area now keeps the profile's last workspace window as its anchor
while the dock itself is the one in focus; only focus leaving the app
sends the dock to the display's edge.

### 2026-09-23: Long work runs beside the chat, and the agent says what it is doing

A dev server or a slow build used to hold the chat on "Working" or vanish
when the turn ended. Now an agent starts it with a background command (ADR
0155): it runs in its own terminal, a chip the person can open, and the chat
moves on. Its step stays in view and pulses, "Running in background", until
the process ends; then it reads "Ran command in background" and folds in with
the other steps, and one quiet line in the chat says it finished while the
agent picks the result up. Quick commands stay on each agent's own shell.

The line under a working chat says what the agent is doing in its own words:
a command's description, the in-progress todo, or the heading of its
reasoning summary. "Working..." is only what it says before it has said
anything.

### 2026-09-23: Automations run for you or for the project; agents can watch

Turning a workflow on asks one question first, to those who manage the
project: runs for **Just me** or **The project**. "Project", not "team": a
project can be one person's brain as much as a company's. A project automation
runs as the project, not as the person who switched it on, so its consent
summary says "The project" and its chats are shared: they carry a small
project mark in the sidebar, the chat header and on mobile, and anyone in the
project can open one and continue it. A pull request review lands as one
project chat, not one per person. Members see the project's automations but
not the controls.

Turning on uses the project's published version. The desktop offers Publish
above the choice (2026-09-24 entry below). Any other host embedding the panel
gets the same safety net inside it: when a workflow is only saved, the panel
says so in plain words and offers **Publish changes and continue** instead of
a "not found" error, and the consent review follows without starting over.

A workflow that listens on a webhook shows its URL in the same panel, with a
copy button and a quiet "Replace URL" that asks once before cutting senders
off. Until the workflow is on, it says "Enable to start receiving" rather than
pretending the URL works.

An agent waiting for something that is not its own process (a deploy, a
review, a file) watches it instead of sleeping. The step reads "Watching" and
pulses like a background command, then settles into "Watched until done" or
"Stopped watching". The chat wakes with one quiet line when the check passes
or changes. A laptop that slept through ten checks makes one when it wakes.

### 2026-09-24: A workflow tab is its graph

A workflow tab used to open with its name repeated under the tab strip,
four header buttons, and an inspector that was always open, with a toggle
that looked like the window's own right-sidebar button. Now the tab is
the graph (ADR 0157). The tab, its rail chip and chat links name the
workflow by its display name. Its state and actions float in the top-right
corner the way a chat tab's do: a status trigger whose popover is the
overview (what it does, saved and preview state, inputs, how it starts,
source, actions), a code toggle, Save only while there is a draft, and Run.

The side panel has a subject or it is closed: the step you selected, the
code, a run, automatic runs, or a change you are describing. It shows a
title and a close button, and clicking empty canvas or pressing Escape
closes it too. "Automate" was on every workflow, even ones with nothing to
automate. It is now an "Automatic" row in the status popover, shown only
when the code declares triggers, and both kinds of run lead with one
Publish action when the workflow is not published yet.

Agent edits are the common way a workflow changes, so they had to read
well. An inserted step used to take over its neighbor's place and the
neighbor faded in below, because the graph and its laid-out nodes updated
on different renders and swapped identities. Identity now comes from each
node, departures clear before arrivals fade in, and steps added off-screen
are panned into view. A clean buffer following the disk no longer flashes a
"changed on disk" conflict on every edit. A change request sends your words
with the workflow as context pills, and its chat opens folded so you can
watch the graph while the agent works.

The canvas follows the app's language: neutral nodes on raised surfaces,
the accent only on the selection, solid still edges instead of marching
dashes, icons instead of emoji, and a start node labeled Start.

### 2026-09-27: GitHub is one of your connections

Signing in to GitHub used to fill a GitHub-only token file beside the
connections everything else used, and an agent watching pull requests
bound GitHub-only trigger kinds that a server never fired. Now the sign-in
is your personal `github` connection, kept in the same vault as every other
connection (ADR 0177). It clones repositories, syncs, opens pull requests,
and shows the PRs panel, with the GitHub CLI as the fallback it always was.

The desktop has no public address for GitHub to call, so a watcher asks the
desktop to poll: new repository activity arrives as the same deliveries the
project's `github` webhook receives on a server, marked as fetched by the
host rather than signed. One trigger library, and the same filters, work in
both places.

### 2026-09-27: Permission mode and sandboxing are two settings

One word, "mode", had come to mean two things: the harness's own permission
setting (Claude Code's plan or bypass permissions, Codex's sandbox) and
Work's rule for what may leave an agent's sandbox. Choosing a harness's
native mode had quietly disappeared (ADR 0182). Now the configure-agent modal
shows "Permission mode" in the harness's own words (Claude Code: Default,
Accept edits, Plan, Auto, Don't ask, Bypass permissions; Codex: its sandbox
and its approvals) only for harnesses that have one, and "Sandboxing"
(Contained, Propose, Publish) apart, each with a one-line explanation.

The permission mode is visible where you work: the chat inspector shows it
beside model and reasoning, the agent pickers name it in each row, and
"Change permission mode" opens a palette picker in the style of the effort
picker. It changes the agent, not one chat, because the mode belongs to the
agent and is part of what a committed definition's consent covers; a
committed or server definition shows its setting read only and says where it
is set. Local agents keep ADR 0140's defaults: Publish, Bypass permissions,
and Codex with full access and approvals on request.

### 2026-09-28: A passkey attempt always ends

A site's passkey button used to leave the page spinning: Electron draws no
Web Authentication UI and keeps no timer, and a stuck request made every
retry fail (ADR 0185). Now the window shows a passkey sheet while a page
waits, in the site dialog's style: the site, "Waiting for a security key",
a plain line on what cannot be used here yet (passkeys on a phone, in iCloud
Keychain or a password manager), and Cancel, which hands the page Chrome's
own refusal so it offers its other ways in. The sheet closes by itself when
the request settles, the site's deadline passes, or the page moves on.
During a Work sign-in it also offers "Continue in your browser". The sheet
shows the site's icon exactly as its tab does, so a dark-theme icon stays
visible.

### 2026-09-29: The palette learns what you use

The palette ranked by text alone, so a page title could outrank the command
you meant, and the focused site's settings topped any query that matched its
host. Now a row's score is its match, what kind of row it is, and how much
you use it (ADR 0186). Commands and app surfaces come before pages unless a
page matches clearly better or you visit it far more. Pages keep their
history counts; Settings, Usage, Sites and the other surfaces count a visit
however you open them; commands count when picked from the palette. Picking
a row after typing teaches that query, so "se" lands on what you chose last
time. The empty palette shows up to six Frequent rows under the starting
actions and the current site's settings, with pages held to half.

Every mode is one shape: a chip, the names that enter it, and its rows.
Pickers, sidebar searches, the new Sites and Commands modes and your own
modes share it, with one set of loading, empty and retry rows. Your agent
adds a mode in workspace.js under palette.modes, from the same sources
sections use, so one module can be a sidebar list and a palette mode. The
file was sidebar.js; it now describes the whole window, so it is
workspace.js, exporting { sidebars: { left, right }, palette }.

Lists load one way. The sources app widgets read (chats, files, workflows,
bookmarks and the rest) are the palette's resources too, and every sidebar
section can open its rows in the palette with its own filter. A mode can
be as small as "running chats": a built-in source and one filter.

### 2026-09-29: Back goes back, wherever you are

The mouse's side buttons only worked in browser tabs. Now they work across
the workspace (ADR 0188): back from a chat returns to the tab you came
from, back again reopens the chat that floated over it. A browser keeps its
own pages; press back on one and it goes back a page, and stops at its
first page instead of leaving the tab. A browser tab closed and reopened
with Cmd+Shift+T, or restored with its window, can still go back: its
back list rides on the tab and goes into the new page before it loads.

### 2026-09-29: Work arrives at the end

A running turn's row was keyed by its text, which is the live activity
line, so every step the agent took rebuilt the row and replayed every step
already shown. Agent rows now keep their identity; a new step opens its own
height at the end of the list and fades in, and nothing above it moves.
In every work display (all notes or the latest; kept or folded after the
answer) steps keep their rows as earlier work folds in above them. Opening
a chat or a finished turn plays no step entrances.


### 2026-09-30: A group wears one eyebrow; pages load on the theme

A chat tab in the top strip wore an accent eyebrow even alone, and a group
drew one per tab. Now only a chat with tabs attached is a group, and the
group carries one line across all of its tabs and the fold chevron. A
collapsed group keeps it over its chat, which still holds the folded tabs.

Opening a page showed white until it painted. Its frame now waits on the
theme's background, as Chrome does; a page with no background of its own
still paints its white canvas once it arrives.

### 2026-10-02: A profile card says who it is and what it connects to

The profile preview listed facts a person cannot act on: the profile's id,
"App opens with: Another profile", and a project count beside the same
projects as chips. It now carries only the profile's identity (its avatar
and name, with a Default tag when the app opens with it, and a settings
gear) and its connections, each with its registry icon, else its https
address's favicon, else a plug. Projects and agents stay out: the card
answers "which profile is this" at a glance, not what it holds. Main reads
the connections for any profile straight from its file: it decrypts
nothing, starts no watchers and needs no unlocking. The menu rows and the
button wear the same avatar as the card.

### 2026-10-02: Keep talking while a question is open

A question used to stop the chat: a message sent while it waited sat in the
queue, and the panel's "Other" row was a second composer that could not take
a pasted screenshot. Now a message reaches the agent at once and the question
stays open as "Answer when ready", so the person can ask about the options
before choosing. The composer is the free-text answer ("Answer in your own
words…"), the panel keeps only options, and its waiting status sits beside the
title instead of on a row above it. Answers read in history as each question
with what was picked. A permission request gives way to a message instead of
staying open. Pasting no longer shifts the dock: preparation spins the attach
button. See ADR 0195.

### 2026-10-02: Your own Claude Code, and update checks that survive sleep

Claude Code chats run the person's own Claude Code when it is at least the
version Work was built with, so a current install brings current models with
no download; otherwise Work downloads its own copy as before. The agent's
settings say which one runs and, when the installed one is too old, offer to
update it with its own updater. Work's checks for its own updates now count
time asleep, wait a minute after waking, retry soon after a failure and keep a
log. See ADR 0196.

### 2026-10-02: A chat is a log every window reads the same way

A chat used to be a placeholder message rewritten on every harness event and
a transcript polled twice a second; questions and approvals waited in one
process's memory, so a restart lost them and the phone saw a different chat
than the Mac. A chat is now an ordered log of turns: every window, the phone
and the server fold the same events, streamed as they happen, and resume
where they left off after sleep or a dropped connection. An approval or a
question is part of the turn, answerable from any of them, and survives a
restart. When the app quits mid-turn, the turn says it stopped and the agent
picks up on its own conversation the next time instead of the reply silently
going missing. Any turn can be undone with the files it changed ("Restore to
here"), and a fork starts from the agent's own conversation at that point.
Claude Code and Codex logins no longer leave the Mac: a remote chat on a
subscription runs only on a machine where the person signed in themselves.
While the agent works and there is nothing to send, the send button stops
it, and a message held for editing keeps its place in the queue.
See ADRs 0197, 0198 and 0199.

### 2026-10-02: Sidebars move first, the page settles after

Toggling a sidebar over a web page shifted the whole page: opening dragged it
along with the sidebar's edge and snapped it back when it resized, and closing
reflowed it on the first frame, then slid it. Now the sidebar slides the
moment it is toggled, and when it stops the page glides into its new place
instead of snapping, as Safari animates its sidebar: snapshots of the old and
new layout move so the page's main column travels straight to where it lands,
and cross-fade. A web page may hold still for a moment between the two while
it lays out at its new size. See ADR 0200.

### 2026-10-02: Talk to Work from the dock

A microphone sits in the dock next to the collapse arrows, on their inner
side. A click starts Work listening: a ring turns around the button until
it really listens, then it lights. The first time, it downloads its speech
models (the ring fills) and makes the profile's voice chat in the dock's
project. Listening and speaking run on the Mac: Kokoro speaks each reply
once it is finished, a sentence at a time as each is made, in one of four
voices (Heart, Bella, Michael, Fenrir) picked from the button's menu along
with the microphone. The chat runs on the person's own agent, Sonnet at
low effort on Claude, with every tool: it looks things up and reads files
itself, saying a few words first, and hands bigger work to sessions, on
the person's agent or one they name, so it stays free to talk. It steers
the person's chats in every project, passes on what sessions report and
ask, and sends the answers back. News that arrives while voice is off shows as a
dot on the button, the voice chat notifies like any chat, and the next
click says the news first. It stops when the person has talked over it in
their own words, or says "stop". The button pulses while it hears; then a
wave passes over five dots while the chat works, until its first sentence
is heard, when they become bars following its voice, a bar per band of
speech, measured from the audio as it is scheduled; another click stops
listening. A microphone that sends only silence stops voice with a
reason, since a MacBook's own microphone goes silent with its lid closed.
Its right-click menu opens the voice chat, picks the voice or microphone,
learns the person's voice so everyone else (a television, a colleague, the
agent's own voice) is ignored, switches push to talk (hold ⌥Space to talk,
let go to send), keeps it in the dock or not, or resets the chat, which
closes it so the next click starts a new one. ⌘⇧Space turns voice on and
off. Out of the dock, the microphone shrinks away in place and comes back
while voice is on; the arrows' menu always offers it back.
See ADR 0216.

### 2026-10-10: An assistant, and voice in every chat

The dock's agent has a name: the assistant. It is Work's built-in
assistant by default, the person's default agent at its harness's default
model, or any of their agents as they set it up, picked in Settings ›
Voice, the dock microphone's menu or the palette; "Create agent…" runs the
usual wizard and makes the new agent the assistant. Every chat's composer
has the same microphone beside Send: talking there continues that chat
with its own agent, which hears that the person is talking by voice and
can answer for the ear, and turning it off carries on in text. What voice
tells agents is information, not rules, so a person who wants an agent to
talk a certain way says so in that agent's own instructions. Each agent
speaks in its own voice, set in its settings, else the default one. The
assistant follows the sessions it hands work to, and hears their notes as
they work, a few at a time, to pass on in its own words; the transcript
shows one quiet line for each. Settings, menus and the palette all write
the same profile prefs, and a live voice follows them. See ADR 0216.

### 2026-10-04: Passkeys live in Work

The passkey sheet used to say passkeys could not be used in Work yet. Now
Work keeps them in the profile's vault, next to passwords (ADR 0201). When a
site creates a passkey, the sheet names the account and offers **Save
passkey**. When a site asks you to sign in, the sheet lists your passkeys for
it. With Touch ID the first is already focused, so Enter then a touch signs
in; without it nothing is focused, so a stray Enter cannot answer. Like
Chrome's, the sheet ignores input for its first half second. Touch ID
confirms each use, the way the system's own passkey sheet does. A tab
without focus is refused, so the sheet never appears over another page. A security key still works
alongside: the sheet says so in one quiet line rather than making you choose
a path first. A site that waits for autofill gets your passkeys at the top of
the suggestions under its username field. When Work cannot help, the sheet
says why in the site's terms (it asks for a security key, it requires Touch
ID this Mac lacks, the account already has a passkey here). With no passkey
saved, **Import passkeys** opens Passwords. There, one Import button takes a
Bitwarden export, a KeePassXC database (unlocked in a small dialog, key file
optional) or a CSV. One sentence then says what came in. Passkeys get their
own section with delete only, since there is nothing to reveal.

### 2026-10-05: Chats glide with the page; agents see what they can do

A floating chat vanished while a sidebar settled and popped back at its new
place: chats live in the dock, outside the content whose snapshot covered
them. The dock now rests on the chat region by CSS anchoring, so it moves in
the same frame as the region, and while the content settles a floating chat
and the bubble strip get view-transition layers of their own and glide to
where they land; a chat open as a tab settles as the content does.

A dragged strip lands on the resting spot nearest its centre, leaving the one
it started from after 40% of the way to the next (the pointer had to cross a
third of the screen). Let go short of that, it slides back rather than
jumping. The detached dock uses the same rule.

A chat is named by its first message the moment it is sent, not "Chat 1"
until its first turn settles; a harness title still replaces it. Typing a bare
host in the palette ("localhost") offers the origins it was visited at, port
included and the most visited first, instead of a portless URL.

Agents now see the browser and their subagents as direct tools, reach the
person's login-shell PATH, and can upload, download and inspect a page's
console, network and JavaScript. A subagent's result arrives in its parent's
turn, labelled with the subagent's name. See ADR 0202.

### 2026-10-06: A click on the page folds the chat

A floating chat stayed open over a page the person had clicked while the
agent worked. A page runs in its own process, so the window saw no press,
and focus moving into the page did not count without one (the 2026-09-20
rule). The page now reports its own presses (trusted ones only; a page's
scripts cannot fold the chat), and `lib/app-focus` counts each as the
person's input and as a press outside everything the app draws, so the
chat lurks as it does after a click on any other part of the workspace.

### 2026-10-06: What slides away is what was shown

Closing the right sidebar with Proposals showing emptied the list into
placeholder rows on the click, before the panel moved, and opening it slid in
placeholders while GitHub answered. Hiding a section reset it: Proposals and
the Server section cleared their state whenever they were hidden or shown.
They now pause instead, keeping their rows and the files chosen for upload,
and refresh in place when shown again. Both sidebars also tell their sections
they are hidden only once the panel has slid off screen, never on the click
that starts it moving, so a section's teardown never competes with the
slide. The two sides share one toggle wherever it appears (the sidebar's
header, the chrome, the corner when the header lives in the sidebar), and a
section in the right sidebar customizes the right sidebar (ADR 0200).

### 2026-10-07: New Tabs that led somewhere close; hovering never moves the list

A day of work left a row of empty New Tabs: each Cmd+T that ended in a click
elsewhere stayed open. A New Tab is a way to somewhere, so once something else
is shown in its place it closes, unless something is typed in it (text or an
entered mode), which it keeps for later, or it is still on screen beside the
other pane of a split. The rule lives in `reconcileWorkspace`, so every way of
leaving (a tab click, a sidebar row, a link, opening another New Tab) behaves
the same.

Hovering the palette's last visible row, which the list clips at its bottom
edge, scrolled the list under the pointer the first time. A highlighted row is
kept in view only when the keyboard chose it; a row under the pointer is
already where the person is looking.

### 2026-10-07: Find in page, in the theme's colors; the downloads popover leaves cleanly

Pages had no find: Cmd+F belonged to diffs alone, and main took the key from
every page whether or not the page wanted it. The action is now Find, and it
acts on what is in front. A page gets Chrome's find bar at its top right
(count, previous and next, Escape back to the page with the match selected),
and the key reaches the page first, so a document editor with its own find
keeps it. Pressed inside an embedded frame (where Google Docs types), the key
stays the page's. The bar and a password offer share one column there, so
neither covers the other.

Selected text and find matches in pages took the system highlight and
Chromium's yellow and orange. Each page now gets the accent through an author
stylesheet (`::selection`, `::search-text`; Chromium paints highlights from
author styles only), the same mix the app selects its own text in. The sheet
comes first and in a cascade layer of its own, so a page that styles its own
selection keeps it, layered or not. Matches inside embedded frames keep
Chromium's colors.

The downloads popover vanished on the second click with no exit, and stayed
open over a page the person had clicked, or after they turned to another
window. It now leaves with the pop-out every popover plays, closes on any
press outside it (a page's included), Escape, or the window losing focus, and
the detached dock keeps the room it lent until the exit has played.

### 2026-10-08: Notes only, and settings that say what they do

Someone asked their agent, twice, for a chat that shows the agent's notes
while it works but not its tool calls, then folds the notes once the answer
lands. Neither attempt could work: a running turn's steps were always open
(2026-09-29), and both choices only moved notes. Each agent also described
its change wrongly, one saying the steps would stay folded, the other that
"latest" showed only the latest step. The settings skill gave agents keys
and values with no meanings, and the descriptions in Settings were vague.

- **Notes only** is a third choice for "While the agent works", not a new
  setting: every note in place, each note's steps behind a closed line, a
  lone step's included ("1 step"), so tool calls show only when opened.
  Commands still running in the background stay in view. Once answered, the
  settled choice decides where the notes go, as before; the steps stay
  folded then too, a lone step's included, so nothing opens as the turn
  ends. With "Fold notes into steps" that is the requested behaviour.
  `foldsSteps` (lib/turn-groups) names the rule.
- **Settings say what shows.** The two choices' descriptions now name
  notes, steps and when each is open, and the options read "Notes and
  steps", "Latest note and steps", "Notes only".
- **Agents read the same words.** The settings skill's table carries each
  setting's Settings label and description, and each value's label, and
  tells agents to say when no value does what was asked instead of picking
  the nearest one.

### 2026-10-08: The strip stays folded until the person opens it

A person folded the bubble strip into its corner, and it kept opening again.
The fold was a component's memory: a reload, a relaunch or another window
showed the strip open, and leaving a chat tab (which folds the strip on its
own) wiped the person's fold along with the tab's. Opening a chat also gave
up the fold for good, so minimizing it again left the strip open.

The fold is now the person's choice, saved with the profile like the strip's
corner and placement (`dockCollapsed`, delivered in the dock snapshot), so
every window, the detached dock and the next launch show it. Only the
person changes it: the arrows fold it, the collapsed bubble opens it. A chat
tab folding the strip and an open chat opening it beside the chat are
temporary and leave the choice alone; opened by hand while a chat tab folds
it, the strip stays open until such a tab gains focus again.

### 2026-10-08: A chat's agent is picked from its status popup, and a chat keeps its harness

People could not change a chat's agent from its status popup: the Agent row
was the one row there with no picker. It now opens the chat's agent picker,
the one "Switch agent for this chat" opens, wherever the popup shows (a
floating or tabbed chat, the detached dock, the sidebar's session card). A
turn in progress disables it, as it does the Model row.

Before the first message, any agent takes the chat. After, only an agent on
the harness the first turn ran on does, continuing the same native thread;
an agent on another harness starts a new chat, and its row says so: "Codex ·
starts a new chat" (ADR 0214). People had switched a Claude chat to Codex and
back, and found the conversation in the ChatGPT app: the handoff gave Codex a
summary with their messages verbatim, Codex kept it in `~/.codex`, and the
chat still said Claude. T3 Code allows that handoff. We chose not to, because
a chat should be where the person thinks it is. Core enforces it, so no
client can hand a conversation to another harness by accident.

What the chat shows has to be its real agent too. The dock keeps a started
chat's entry on the agent its session runs on, so the pickers target it even
for a chat older than the project's session list; an agent no longer in the
roster reads "Unknown agent", never the default's name. And the setup wizard
removes the agent of a sign-in left unfinished once another is set up, so a
ChatGPT sign-in started and abandoned no longer stays as the default.

### 2026-10-08: A browser tab goes back to the person when the agent's turn ends

A tab the agent opened kept its chip spinning after the agent was done, and
stayed veiled ("Agent owns this page") so the person could not use it
without taking control: the spinner, the veil and the tab's exemption from
sleep all follow "agent-controlled", and only the agent's own
`surface_control release` or the person's take-over ever cleared it.
Agents rarely release.

The agent now holds a tab it opened from its first action in a turn
(opening, looking or acting) until that turn settles, and the main-process
bridge hands every tab the session held back to the person then. That is
not a take-over: a later turn may drive the tab again, and holding it again
shows the spinner and the veil again. A take-over still refuses the agent
until it reclaims. The person's own tabs are never held: an agent drives
one only when asked, without veiling it, as before.

### 2026-10-09: Google signs you in again, on a beta Electron

Google's sign-in page in a Work tab started answering "Couldn't sign you in:
This browser or app may not be secure". Work already presented as Chrome
(the user agent and the client-hint brands a page reads), so the gap was
the engine: Chrome 156 reached stable on 2026-10-07, Google admits only the
newest Chrome majors, and every Electron 44 release, 44.7.0 included, still
carries Chromium 152. The app moves to Electron 45.0.0-beta.1 (Chromium 156),
pinned exactly, because no stable Electron is recent enough yet; it follows
the 45 betas to stable (ADR 0150).

The identity now matches Chrome 156 more closely too. The user agent is
Chrome's reduced one, `Chrome/156.0.0.0`; the full version reaches a site
only through the client hints that ask for it. The brand list is built the
way Chromium builds Chrome's, so its placeholder brand and order follow the
major version (`"Not:A-Brand";v="8"` first for 156) instead of a fixed
string from an older Chrome, and `JSON.stringify(navigator.userAgentData)`
agrees with `brands`. Page loads still carry no client-hint headers, which
Electron does not send (TODO.md).

Electron 45 reports a page's screen share as its own `display-capture`
permission instead of a camera or microphone request with no devices. The
share picker now opens on that permission, so Meet and other calls still
get "Choose what to share" first, and Cancel still refuses the way Chrome
does. The `Invalid guestInstanceId` error Electron threw when a loaded tab
closed is fixed in this release, so the app stops hiding it.

### 2026-10-09: A held page answers a press; the caret keeps Cmd+Left

Someone who missed the "Agent owns this page" pill pressed the page and
nothing happened. The veil is invisible until then: a press shows it for a
moment, a sheet of translucent plastic in the accent, a little stronger and
giving way where it was touched, then clearing. The page still gets nothing.
At 760ms it is a sanctioned exception to the motion contract; with reduced
motion it collapses like everything else.

A chat's tab group kept its accent eyebrow and fold chevron after the person
moved to another tab, so a group opened beside a chat (a chip opened with
Cmd+Shift+Click) looked in focus long after it was. The group now wears the accent
only while it holds the tab in front or its split companion; behind, its
eyebrow and chevrons go quiet.

Cmd+Left and Cmd+Right went back and forward even with the caret in the
composer or the address bar, so they never moved to the line's start or end.
A text field now keeps its caret keys, whatever they are bound to, in Work and
in pages, which see back and forward first like Cmd+F; elsewhere they still go
back and forward. An embedded frame has no preload, so main asks the focused
frame whether a text field has the caret before going back or forward.

A browser tab's hold is the turn's, not the chat's: a settle that arrives
after the chat's next turn started no longer lets that turn's page go.

### 2026-10-09: A closing sidebar's items leave first

The sidebar slid away as one sheet. Closing now reads as the items leaving
and the sidebar following them: what shows on each row (its icon or image,
its label, a description) leaves together toward the edge the sidebar goes
to and fades, in a quick sweep from the top, and the panel starts 100ms
after the click. A row with text travels exactly its own length and draws a
hairline in its text's color behind it, so the line grows from where the
row ended and its free end stays on the row's trailing edge: the row pulls
a thread out of its place and never crosses it. The threads are what the
items leave behind, and the panel carries them away.

Two takes lost. Soft bars the size of each label (a skeleton left behind)
read as loading, and over text that was still fading they looked smudged.
A hairline across the middle of each label read as strikethrough, as if
the items had been crossed off. Hidden hover actions must leave nothing,
so only what is drawn and opaque leaves (`checkVisibility`).

The review of the first version moved the motion to Web Animations: CSS
animations removed on reopen snapped every item back in a frame, and the
shorthand stopped a row's own spinner. Now opening mid-close plays the
items back from where they are, and a close that reverses an opening panel
doesn't wait for items. Pieces of a row are clustered (close together on
one line), so a favicon travels with its label and one thread spans the
row; in the right sidebar the thread trails the icon instead of crossing
it. Everything is measured once on the click, only for what is on screen;
nothing runs under reduced motion or in a project's workspace that isn't
showing. Opening is unchanged.

The content beside the sidebar used to settle by morphing: its box grew
or shrank into place while its snapshots travelled with the main column.
The growing box showed the app's background around it for a moment, which
read as a glitch. It now fades in place: the old layout fades out exactly
where it was as the new one fades in, and nothing moves or stretches. The
page probe that told a centred column from a left-aligned one is gone with
the motion it served. The fade is linear over 300ms: on the standard curve,
which does most of its change in the first quarter, a 200ms fade read as a
snap.

A review found three things the fade needed. A custom fade drops the
browser's plus-lighter blend, so the pair dimmed toward the sidebar's
colour midway; the snapshots now blend plus-lighter. A chat tab in the
right half of a split moves by part of what the content does, so it gets
its own offset rather than the content's. And a compact window's
hover-revealed sidebar closes without the items' lead: a peek is dismissed
often, and should go at once.

### 2026-10-09: A chat's own worktree is the person's choice, and comes back from the popup

Only agents could give a chat its own worktree, and nothing about it was
finished: no ignored files or dependencies, no cleanup, and no way back
except a pull request. On this machine no Work profile had ever made one,
while the repository held dozens of Claude Code worktrees.

"New chat in a worktree" in the palette, or "Use own worktree" in the
status popup's Folder row, now chooses one; the chat's next message checks
it out at the project folder's last commit, copies the ignored files
`.worktreeinclude` lists and runs the Environment's setup (ADR 0215). The
Folder row is where the chat says where it works: "Project folder", its
branch with the folder and how many files it changed, "put away" while the
chat is archived, or an assigned worktree. Between turns the row offers
what fits: bring the changes to the project folder (written there
uncommitted, refused with nothing changed when they would collide with the
person's own), discard after a confirmation, or use the project folder
again. The popup's trigger carries a branch mark while the chat works, or
will work, in its own worktree, so a tabbed chat with its header folded
still shows it. The sidebar's session card shows the same row, and the
Changes section names a worktree's chats by title instead of an id.

Archiving a chat puts its worktree away: everything is recorded on its
branch and the folder goes, so worktrees no longer pile up; the next
message checks it out again. The default stays the project folder, because
most projects are not code and the main complaint about Claude Code's
worktrees is that people cannot opt out.
