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

## Agent setup and conversation controls

Agent setup shows the shared harness or provider logo where one exists, with the
generic agent mark otherwise. Names begin as actual editable text. Subsession chips use the same harness or
provider icon as their chat's status popup, and follow agent changes. Renaming a
chat focuses its name with the whole value selected, so typing replaces it.

Picking another agent continues the same chat, including across harnesses
(ADR 0276). Each harness keeps its native thread and receives a bounded context
handoff for turns it missed. Agent changes clear conversation model and effort
overrides. A working turn must settle before the agent can change. A model value that
cannot change explains why on hover; the idle model picker uses the palette.

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
A `work:prs` list opens PR review. Members submit selected files through
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

## Menus and popovers

A **menu** is a list of commands: an overflow (⋯) button's, a right-click's,
a page's. It is always `MenuPortal` (`components/menu.tsx`, ADR 0221) with
its entries as data (`shared/menu.ts`), or a native menu main builds
(`desktopApi.*Menu`). Open it with `menuAtControl` under its control or
`menuAtPointer` at a right-click, pass `anchor` so it leaves with its row,
and run the picked action from `onExited`. While open it holds the window: a
press anywhere else, a web page or an app's frame included, only closes it;
Escape, focus or the window leaving, and its anchor going close it too, and
focus goes back as the app's move (`moveFocusAsApp`), so the control it
lands on opens no hover card. A menu opened inside a hover card holds the card
(`useHoldInspector`) from opening until it has exited, so the card neither
closes under the menu's shield nor takes Escape before it; once the menu
has gone, the card stays only if the pointer is on it (or the keyboard
leads and focus is in it), wherever the press that closed the menu landed.

A **popover** is anything else that drops from a control: a switcher whose
rows preview on hover, a bubble with toggles or a field. It closes through
`usePopoverDismiss` (`lib/popover-dismiss.ts`): a press outside it (which
goes on to what it lands on), a press inside a page, the window losing
focus, and Escape once nothing above it took the key (an open menu takes
it first). Presses on its rows' cards and menus are its own. Focus it hands
back is the app's move (`moveFocusAsApp`), which opens no hover card. A
popover that is a dialog takes focus as it opens and hands it back as it
closes. No menu or popover keeps press or Escape listeners of its own; a
hover card closes on a press in a page too, and when its control turns
inert or hidden (its list or sidebar closed).

Design lint fails a file with more menu controls (`aria-haspopup` "menu"
or "true", an overflow icon) than menus it draws (`MenuPortal`) or asks
main for (`desktopApi.*Menu`), a `role="menu"` outside the primitive, and
a file with more other popups (a `dialog` or `listbox` control or role,
the control and its popup counted once) than `usePopoverDismiss` calls,
unless it is listed with how it closes. A registry component that pops up
(`components/catamorphic/`) takes its host's dismissal as a `useDismiss`
hook, and the desktop passes `usePopoverDismiss` wherever it draws one.
Window, document and body listeners for presses and keys are listed per
file with their job, registry copies included.

## Shape & spacing

- Radii: `--radius-sm` 4px (inputs, chips), `--radius-md` 6px (buttons, list
  rows), `--radius-lg` 10px (panels, dialogs).
- **Nested corners are concentric.** A rounded control sitting in a rounded
  container's padding takes the container's radius minus that padding, and
  the relation is written down rather than hand-tuned: the composer sets
  `[--composer-radius:12px] [--composer-inset:6px]`, and its buttons use
  `rounded-[calc(var(--composer-radius)-var(--composer-inset))]`.
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
rows already draw the inset ring on their rounded box, and a tree (the kit's
`Tree`, every sidebar list) draws one ring of its own (`[data-tree-focus]`)
on the focused row's box, which glides to the next row as the arrows move
it. Its rows touch, so that ring sits wholly inside the row, offset by its
full width rather than the 1px inset (ADR 0238). Text fields keep their
border-and-glow focus instead.

- **The keyboard leads.** `lib/focus-modality.ts` marks the root `pointer`
  after a pointer press and `keyboard` after Tab, arrows, Home/End,
  PageUp/PageDown, F6 or the context-menu key. While the pointer leads, rings
  are off, so Escape or Enter after a click never lights the focused control.
  Row previews open on focus only when the keyboard leads. A shortcut that
  moves focus somewhere new (Cmd+B onto the sidebar's row) counts as the
  keyboard (`keyMovedFocus`), so its ring shows on arrival; a press that
  opens the same surface leaves the ring off until the first arrow.
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
   The theme points Tailwind's `--default-transition-timing-function` at it,
   so a bare `transition-*` class is already on the curve; name it with
   `ease-standard`, never a `cubic-bezier` literal. Registry source keeps the
   literal, since a host may not define the token.
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
fade in place from its old layout to its new one (ADR 0200). Beside a page,
terminal, code editor or app frame the content resizes once per toggle,
never while anything moves. Content Work draws and lays out cheaply (a
chat, a note, Settings) moves with the panel instead: the sidebar's place
grows or shrinks on the slide's own transition, so the content's edge
rides the panel's, and the chrome's sidebar toggle folds and unfolds in
step so the tabs after it never jump. New motion beside a page, terminal,
editor or app frame moves over it rather than animating its size.

What an agent does to the workspace moves as what a person does: its opens
and closes go through the same functions as a press on its surface's chip
or a tab's close button, with their tab, split, floating and sidebar
motion. A person's click swaps the content at once, since their own press
is the cue; a swap nobody pressed for (an agent's open or close changing
the tab in front) narrates with `pane-in-left` / `pane-in-right` from that
side of the strip. Nothing moves in a project or window that is off
screen, or under reduced motion.

### Current motion inventory

| Animation | Duration | Pairs with |
|---|---|---|
| `dock-in` / `dock-out` | 250ms | each other |
| `bubble-in` / `bubble-out` | 200ms | each other |
| Bubble strip fold (the chats' `width` from their own size, capped by `calc-size`, never a `max-width`; the rail's gap and padding; its slide between resting spots) | 250ms | itself: one motion both ways, reversing from where it is (the slide shortened as CSS shortens the reversed transitions, so both land together); folded beside a leaving chat, however it leaves, it runs with that chat's exit |
| `tab-in` / `tab-out` | 200ms / 180ms | each other (exit snappier) |
| `.workspace-tab-close` transition (a strip tab's close button showing on hover or keyboard focus: opacity and scale 0.8 to 1, over the label's end; the title's end fades under it through `--tab-title-end`) | 150ms | itself: one transition both ways, so a pointer crossing the strip turns each back from where it is; nothing beside it moves |
| `.sidebar-tab-slot` transition (a sidebar tab's place growing in or shrinking out of its strip: a tab of `when.session` sections beside a chat; `@starting-style` for arrival) | 200ms | itself: one transition both ways on one element, so a quick change back reverses from where it is; at no width the place gives back its flex gap |
| `.sidebar-strip` transition (a sidebar's tab strip opening as a second tab arrives, folding as the count drops to one; never for the sidebar's own opening) | 200ms | itself, reversing the same way; the panel below follows its height |
| Menu rows changing while it is open (a microphone plugged in or out; `useMenuListMotion` in `components/menu.tsx`: rows glide and arrive by `useListMotion`, the panel's height follows by Web Animations, a changed detail such as "Default" fades in) | 200ms; the detail 160ms | each other, on one curve: the panel grows or shrinks with its rows, reversing from where it is drawn; opening a menu or another submenu moves nothing |
| `fade-in` / `fade-out` (modal section swap; agent-control overlay) | 200ms | each other (exact mirror; `fade-out` holds its final frame for removal on animationend) |
| `modal-in` / `modal-out` (dialog panel: opacity + scale 0.96↔1) | 200ms in, 160ms out | the backdrop's `fade-in`/`fade-out`; `modal-out` holds its final frame until the backdrop unmounts both |
| `pairing-qr-in` (QR readiness reveal) | 200ms | — (one-shot content-ready signal inside a fixed stage) |
| `profile-veil-in` / `profile-veil-out` (in-place profile switch) | 200ms | each other (exact mirror) |
| `question-in` (ask_user panel) | 260ms | — |
| `pane-in-left` / `pane-in-right` (keyboard tab cycling; an agent's open or close changing the tab in front of a visible workspace) | 200ms | — (content-changed signal on a persistent wrapper; no exit to pair; a person's click stays instant) |
| `agent-pointer-in` / `agent-pointer-out` (`point_at`'s ring and its note) | 200ms | each other (exact mirror; the entrance's fill holds the ring steady, `agent-pointer-held` puts it back unanimated after a re-render rewrites the element's classes, nothing loops) |
| `content-fade-out` / `content-fade-in` (content settling beside a still sidebar, view transition: the old snapshot fades where it was, the new one fades in) | 300ms, linear (a sanctioned exception) | each other (the old snapshot leaves as the new one arrives) |
| `dock-float` / `dock-rail` / `workspace-tabs` groups (a floating chat, the bubble strip and the tab strip gliding while the content settles, view transition) | 200ms | within the content's 300ms fade; a chat tab (`dock-tab`) fades in place with `content-fade-out` / `content-fade-in` from its own place |
| Tab strip `translate` (the horizontal strip slides with the left sidebar's panel, to where the settle puts it) | 200ms, the panel's easing and item wait | the panel's own slide; dropped without a transition when the content settles |
| `.tabbed-sidebar[data-push]` width (the sidebar's place growing or shrinking with its panel beside content Work draws, so that content rides the panel's edge) | 200ms, the panel's easing and item wait | the panel's own slide, reversing with it |
| `.chrome-toggle-slot` fold (the chrome's sidebar toggle folding away as a pushing panel arrives and unfolding as it leaves, its gap with it; `@starting-style` for arrival) | 200ms, the panel's easing and item wait | the panel's own slide; gone or at its own width once the panel is still |
| `[data-tree-focus]` glide (a list's keyboard ring following focus from row to row: its `top` and `left`, only while it moves between rows, `data-glide`; arriving in a list it appears in place, and otherwise it rides its row's own 200ms slide when rows move under it) | 150ms | itself: the ring turns from where it is when the arrows outpace it |
| `.overlay-scrollbar` fade (the scroll position of the sidebar's panel, on its outer edge, and of a section's list that asks for a thumb, `scrollbar: true`, a lane in, while it scrolls or the pointer nears that edge) | 150ms | itself: one transition both ways, fading 900ms after the last scroll |
| Markdown format bar (Web Animations in `components/markdown/motion.ts`: in, rising 4px from 97% and transparent; out, the same way back, in place and inert) | 160ms | itself: one motion both ways; shown again mid-exit, or hidden mid-entrance, it turns from where it is over the share of the 160ms left |
| Markdown drag handle (`.cat-mdedit-handle`: appears with opacity and scale 0.9 to 1; the extension jumps the box to each block and the grip inside glides there on a `transform` animation, which runs on the compositor) and table row grip (`.cat-mdedit-rowgrip`, placed and gliding by `transform`) | 160ms appear / 140ms glide | itself |
| Chip motion (Web Animations in `components/chip-rail.tsx`: a chip arriving rises 4px from 96% and transparent; one leaving fades and sinks the same way where it stood; chips that stay slide from their old place; the rail's `height` transition follows its lines) | 200ms in and slides, 180ms out | each other (exit snappier); reduced motion settles at once |
| Chip glyph cross-fade (a chip's new icon scales in from 60% over the one it replaces, as a pull request merges) | 150ms | itself: the old icon leaves as the new one arrives |
| Reply image reveal (Web Animations in `components/remote-image.tsx`: the line the image's name held opens to the picture's height as the picture fades in from 98%) | 200ms | — (one-shot content-ready reveal; nothing leaves) |
| `bubble-ask` (agent question arrival) | 280ms | — (one-shot nudge on a persistent bubble; no exit to pair) |
| `input-recall-{up,down}-{a,b}` (composer ↑/↓ history) | 150ms | — (transform-only directional content signal; paired names replay rapid same-direction recalls without a classless frame) |
| `cat-swap-out` / `cat-swap-in` (text changing in place: the agent's activity line, a steps line's count and word; shared from `@catamorphic/ui/styles.css` with `cat-fade-in`, `cat-fold-away` and `cat-step-in`) | 200ms / 200ms | each other (opacity only: the old text fades out from the opacity it had, the activity line's breath included, then the new fades in; the activity line resumes `animate-pulse`) |
| `.cat-swap-slot` transition (a changing label's place, so what follows it slides to the new width) | 200ms | itself, only while a swap plays |
| `.cat-reveal` transition (the activity line and the turn line above it opening and closing their height; `@starting-style` for arrival) | 200ms | itself: one transition both ways, giving back the column's gap when closed |
| `.cat-grow` transition (prose being written follows its own height) | 180ms | — (only while the text streams; the box lets go once written) |
| sidebar leave (Web Animations in `lib/sidebar-leave.ts`: a closing sidebar's rows leave, each drawing a thread behind it; the panel's slide waits 100ms for them) | 160ms | its own reverse when the sidebar opens mid-close; opening shows the items in place as before (a sanctioned exception) |
| `title-change` (rename flash) | 1200ms | **sanctioned exception** — the
  one decorative-adjacent signal (see design log 2026-07-31); allowlisted in
  the test's `DURATION_EXCEPTIONS` |
| `veil-touch` (a press on an agent-held surface) | 760ms | **sanctioned exception**: one-shot answer to a refused press; the sheet appears, gives, and clears (design log 2026-10-09) |

### Sanctioned exceptions

- `animate-spin` / `animate-pulse`: indeterminate progress may loop, only
  while it shows: a loop keeps the compositor and GPU drawing every frame,
  so a mounted but invisible alternative (an inactive cross-fade, the
  open strip's folded bubble) does not run one.
- `voice-spin` (900ms) and `voice-ripple` (1200ms) on a microphone: live
  states that last as long as they are true, the speech models loading and
  the person being heard; still under reduced motion.
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
  40px. No dead space above tabs. The window buttons are a profile choice
  (`windowButtons`); hidden, the corner kept for them goes too and the
  project switcher moves up into the sidebar's top row, across it. The
  chrome's empty room drags the window, as in Chrome: the tab strip's
  spare end (both ends when tabs are centred), or the title row with tabs
  in the sidebar. Tabs, the + and toggles take presses; while a tab is
  dragged, the strip's end is its drop target.
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

Every list section, Work's or a person's, is the same kind of thing: a source of
rows inside shared chrome (ADR 0234). The chrome owns status; sources own rows,
and one component (`source-section.tsx`) draws every list.

- **One status language.** A section reports `{state, refreshing, error, retry,
  empty}` and renders rows only. The section header shows a small spinner while
  loading or refreshing and a hover-revealed Refresh button otherwise; the body
  shows three still skeleton rows before the first result, one muted sentence
  when empty (`section.empty` in `workspace.js` replaces it), and the error with
  Retry when a read fails. Rows stay on screen during a refresh; collapsing and
  re-expanding never discards what was already loaded.
- **No private loading text.** "Loading…", spinners, skeletons, empty copy and
  error paragraphs inside a section component are defects.
- **Long lists load as they are read.** The shared tree reads a branch's next
  page once the person moves within a viewport of its end: each gesture
  (wheel, touch, a press, keyboard movement) allows three reads while each
  moves the end down. Until a page lands, three still placeholder rows (the
  chrome's skeleton, at the list's end) hold the place, the header stays
  still, and a polite status tells screen readers. The rows arrive with the
  row motion where the placeholders stood, which wait again at the new end;
  after the last page they fade where they stood. A page that showed nothing
  new (a filter, a closed group) or a spent gesture leaves Show more at the
  end until the person moves again, so no list reads its whole history on its
  own. A failed page ends the list with its error and Retry in the chrome's
  voice, beside the tree; the loaded rows stay and focus stays on the last
  one. Chats read 30 at a time. Polls read a list of two pages or fewer whole
  and only the first page of a deeper one (every loaded page about every 30
  seconds, on focus and on Refresh). What is in front is always in its list
  when the source can place it (`reveal`): an older chat shows past the end,
  without reading every page above it.
- **One drag-and-drop model.** The shared `Tree` owns pointer math, the accent
  insertion line between rows and the accent outline on the row (or tree) that
  becomes the parent. A section only declares what a row offers when dragged and
  what a target accepts, through the same `move`/`drop` contract every source
  exports, Work's lists over their stores. Rows with
  children are the only "inside" targets. No section owns drop zones, drop-zone
  classes or payload formats of its own; `data-bookmark-drop`-style private
  attributes are defects.
- **Rows and tiles.** A row's overflow menu button appears on hover; a tile
  has no room for one and opens the same menu on right-click only.
- **One keyboard ring per list.** A list draws its ring once, over the
  focused row's own box, wholly inside it (offset by its full width) and
  above every row, so no row covers or clips it and it never reaches a
  neighbour. A child row's indent is its box's place (`indent` on the kit
  tree), never a margin inside the row, so the ring and the row's highlight
  start where the row does. The ring glides 150ms to the next row as the
  arrows move it, and moves with its row when rows slide.
- **An opened sidebar takes focus to what is in front.** Opening a sidebar
  focuses the row of what is in front (a list's selected row, when the list
  has it loaded), so the arrows work at once; with none, focus stays where
  it was. The app moves that focus (`moveFocusAsApp`), so it opens no row's
  preview of what is already in front. The arrows go on past a list's last
  row into the next list shown in the panel, and up past its first into the
  last row of the one before (`onTreeLeave`; a list with more to load keeps
  the key and reads on). A row the keyboard or the opening focuses comes
  into the panel's view, clear of its faded edges; focus a menu hands back
  to its row leaves the panel still.
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
- **A list fades where it continues.** No sidebar list keeps a scrollbar
  or a column for one. The sidebar's panel and every section's list fade
  their content out over the last 24px of an edge with more beyond it, and
  only then (the registry's `edge-fade` with `cat-edge-fade`); the chat's
  conversation and the palette's results do the same, instead of cutting
  their content at a hard edge; a long note does too. Thin overlay thumbs
  stand in for scrollbars, in lanes from the sidebar's outer edge in, and
  never over each other (ADR 0248): the sidebar's own panel has one on the
  edge, and a section that asks (`scrollbar: true`; none of Work's do) has
  one a lane in, in 8px more outer padding its sidebar keeps for it,
  spanning that list's height. Each is hidden at rest, fades in as its list scrolls or the
  pointer nears the edge beside it, can be dragged, and fades out a moment
  after (`components/overlay-scrollbar.tsx`).
- **A row's chevron ends it.** A row with children ends with its
  disclosure, after its actions and centered under its section header's,
  so every row's icon starts in one place and only a child's indent says
  it belongs to the row above.
- **Drags reveal only what accepts them.** A section hidden for being empty
  whose source takes drops (pinned pages) opens while something it takes is
  dragged, says what a drop does with its empty sentence, and stays a moment
  after the drop so what arrives lands in view. Hover previews close when a
  drag starts.
- **A list without a heading stands alone.** `title: ""` drops the header:
  pinned tiles and the imported library sit above Bookmarks without labels of
  their own.
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
- **Popovers open at their size.** A hover inspector's reads start once the
  pointer has rested on its trigger a moment (`ResourceInspector`'s
  `warmup`; a pointer passing over reads nothing), and the panel waits,
  unseen, for those its content reports pending (`useInspectorPending`) at
  most 250ms, on every path it opens by (hover, keyboard focus, a request),
  so it opens with what it shows. It appears only while it is still open:
  one closed before it was seen (the pointer or Tab moved on) goes at once,
  with no exit motion to flash it. A value still loading holds its line with
  a still skeleton bar of the line's height, never "Loading…" or "…" text of
  another height; a read that fails or finds nothing says so quietly on its
  own line ("Unavailable", "None"), never in a warning banner, and a state
  that is simply not set up (no Git remote, no server, the GitHub CLI off)
  is not a failure. Inspectors still measure their content and transition height and
  position, for content that is genuinely longer than its placeholder (a
  list). A popover that shifts its layout on load is a defect.
- **Pointer and focus hold an inspector independently.** A hover inspector
  stays open while the pointer or keyboard focus rests on its trigger or its
  panel, so the pointer passing over and away never closes what focus holds.
  Focus from a click (a pressed button in the panel included), returning to
  the trigger after Escape, or moved by the app leaves the inspector to the
  pointer.
- **Primitives, not presets.** There are no section types. Work's lists are
  `work:*` sources on the contract a person's module implements (`load`,
  `subscribe`, `action`, `move`, `drop`, `reveal`), with the same fields
  around them (`empty`, `headerActions`, `itemDefaults`, `itemOverrides`,
  `presentation`, `height`, `rowHeight`, `scrollbar`). A row gets Work's knowledge of what
  it names by its address (a chat's glyph, signals and live inspector; a
  page's favicon; the active highlight), never by which source wrote it. A
  header button is a header action (New tab is `command:new-tab`). When a
  list needs something rows cannot say, the row, action or `work` contract
  grows for everyone; a component of its own is a defect. A sidebar an agent
  writes looks like Work's own without extra effort, and cannot break the
  chrome.
- **Lists that sort move their rows.** A source may reorder its rows on any
  read (a module wrapping `work:tabs` puts working chats first); rows keep
  their identity, so one that changes place slides to it with the tree's
  structural motion.
- **Tabs follow the chat in front, and never take the panel.** A tab whose
  sections need a chat's session (any `when.session` section, such as one
  showing `work:session`) exists only
  beside the chat, or a page, file or terminal it opened, whose session the
  sidebar keeps (ADR 0226); its links open as the chat's, in a tab it owns,
  so a click never takes the tab away under the pointer. It is never the
  default choice: arriving never changes the tab shown, and the person's
  choice of it comes back with the next chat. Its place grows into the strip
  while its neighbours slide and shrinks away the way it came, on one
  element, so a quick change back reverses; the strip opens and folds as the
  tab count crosses one. Only changes to tabs already shown move: never the
  first list, nor the sidebar's own opening. When the tab in front leaves,
  the panels cross-fade to the one that stays, and the leaving panel's
  sections keep their shape as it fades. Focus in what leaves moves to the
  tab or panel in front. Any source in a `when.session` section is given the
  chat (`work:session`, or a module) and shows its metadata the same way,
  read where the chat reads it (a connected project's own access); a failed
  refresh keeps the rows it had.

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
  (`{ selection, overrides, fonts?, backgrounds? }`) — profile-local, file-watched, agent-editable.
  `selection: "system"` resolves to the Work Light or Dark preset and
  follows operating-system changes live.
  ThemeProvider writes each resolved color as an inline CSS variable on
  `<html>`, sets `color-scheme`, and mirrors the appearance to
  `data-theme` for anything keyed on it.
- `backgrounds.left`, `.right` and `.chat` put an https picture behind a
  sidebar or the chat (ADR 0263). It stays visible at its `position` and
  fades into the surface's own color away from it, so the surface stays
  readable; opacity, blur and pixelation are data with fixed ranges, never
  CSS. The surface isolates a stacking context and the picture fades in once
  loaded.
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
### 2026-10-21: Tabs switch at once; a waiting chat shows what it waits on

Switching to or from a chat tab played the floating chat's open and close
(a quarter second of fade and scale): a chat tab behind another took the
minimised pose. It now keeps its tab pose and hides at once, as a page
does, so a switch shows the next tab in the frame after the press.
Closing a page nobody touched closes at once too, without asking the page
first. Measurements are in [Performance](docs/performance.md).

A chat whose turn is doing nothing but wait (for its subagents, or on a
watch or command it reads with a wait) shows what it waits on, not the
spinner: the agent is waiting, not working. The folded bubble speaks for
the chats in the dock only; a chat in a tab says what it is doing on its
tab. A wide chip stays within the composer however long its title, and a
pull request's chip reads its status again when the window comes back.

Holding the key or the microphone sends one message, however long the
hold: past 30 seconds the recognizer hears it in pieces, which now wait
for the last and go together.

### 2026-10-21: A chat's icon says what it is doing and what needs you

A chat's icon has two corners now (ADR 0273). The upper one says what
needs the person: the "?" of a question, the pulsing dot of attention,
the dot of an unread reply, the pencil of a draft. It stays while the
agent works again, so a reply that landed meanwhile is not lost. The lower
one says what the chat is doing: the spinner while it works, and while it
rests, what it left running: an eye for a watch, a bot for subagents at
work, a terminal for a background command, quiet in the muted ink. One
mark per corner; the eye before the bot before the terminal, and a
question holds the spinner back while it waits. Tabs, bubbles, the
folded bubble and the sidebar's Tabs rows draw it, and any row or chip
that sets `activity`; the gap the mark cuts from the icon moved with it
to the lower corner. A custom chat icon's little chat marker gives that
corner up while it is in use, and the folded bubble's count moved to its
lower-left corner to leave it free. A tab's hover card says both: "New
reply · Agent is working…".

### 2026-10-21: The composer keeps to the message; closing a tab goes back

The composer shows the message and its controls, nothing else: the context
ring is gone, as the hint went with the "/" and "@" menus below. The Usage
page still reads what turns report.

Closing the tab in front returns to the tab the person was on before it,
as a browser's history would, instead of the last tab in the strip:
Cmd+W on a page a chat's link opened lands back on that chat. The
workspace keeps the tabs left behind, newest last, with the rest of its
state, so this holds after a relaunch; closing one pane of a split still
lands on the other pane.

### 2026-10-21: The composer's "/" and "@" menus

`/` no longer leaves the composer (ADR 0274). `/` or `@` starting any word,
mid-message included, opens a compact list right above the composer, as wide
as it: one 32px row per entry with its icon, its name, a muted description
that truncates, and a chevron when the row opens a picker. No header, no key
hints, no second input; the composer keeps the caret and names the
highlighted row as its active descendant. The list caps at twelve rows and
scrolls, follows the palette's selection fade and list motion, and pops in
and out as every popover does. `/` is alphabetical with the most used under
Recent; `@` keeps quiet group labels (Open tabs, Files, Chats, Workflows,
Apps), folders before files with their parent path muted. A skill picked
from `/` is a pill in the message, like a mention, so "fix the login bug and
⟨Code review⟩" reads as written. A catalog still loading holds a row with a
still bar; a failed one leads the list, where Enter retries. The empty
composer carries no hint: the placeholder and the message have the room.

### 2026-10-21: Connectors reads like a catalog

The Connectors dialog is a two-pane catalog in the shape of an app store.
A rail holds Browse, Plugins and MCP servers, then everything installed by
name, with a warning dot where a sign-in needs attention. Browse shelves
the plugin catalog by the marketplaces' own categories, six to a shelf,
vendor-named entries first; a shelf's title opens all of it under Plugins,
whose category pills filter in place. A row is an icon tile, a name and
one line, and a quiet round `+` that becomes a check once installed; the
rest of the row opens the connector's page. Tiles show the registry icon
or the favicon of a vendor's own site (never a code host's, which would
give every entry the same mark), else the name's first letter.

Each connector has a page: a large tile, the name with who publishes it,
its one primary action, the full description and a row of facts. An
installed connection's page holds its status, Test and Authorize, the
"Available to agents" switch and its tool permissions; a plugin's lists
its MCP servers, and an uninstalled one offers more from its category.
Pages stack under a breadcrumb; the search pill stays in reach and typing
returns to results, which list in one column and glide with the shared
list motion. Native `title` tooltips on the old rows went with them.
### 2026-10-21: Work asks before code reaches anything, and what agents write reaches only trusted hosts

Agents read what other people wrote, and some of it is written to instruct
them (ADR 0277). Opening a link or loading an image sends its whole address
to its host, and the agent chose the address. So an image in a reply from a
host the chat does not trust is a quiet pill naming the host, with Show (this
once) and Always show from the host; a web link to such a host opens a
dialog with the whole address, Open, and Always open links from the host.
One list answers both: Work's (GitHub's hosts, Wikimedia, MDN, this
machine), the project's committed `trustedHosts`, and the person's own. A
trusted image grows into its place once it is ready. The consent pill keeps
its position, width, height and controls through approval, a slow response,
and retry. Its actions use PendingButton; the host is named once and the
actions stay Show and Always show. One persistent frame then changes from
the pill's measured size to the picture's size over 200 ms on the standard
curve, fading the pill out as the picture fades in. Reduced motion settles
at once. A failed image or host save stays in the same pill with a visible
reason and retry. Rows' and chips' icons
come from main, only for sites a tab of this profile showed. Files, notes,
pull request comments and theme pictures load as they did.

A sidebar, palette or chips module runs confined to what its package.json
declares. Its section, mode or chips show Work's request in place of rows,
worded by Work, never by the module: what is new since it was last allowed,
what it already may, and when project files could leave with it. One Allow
covers the module wherever it shows; an edit that widens it asks again,
and one that does not runs at once. The request is a section state beside
loading, empty and error, so it draws the same in every section and a
section that hides when empty still shows it.

### 2026-10-20: Skills live in the palette; "/" opens them from a chat

The composer's `/` menu is gone (ADR 0270). Skills are a palette mode with
the palette's own ranking and keyboard: `/` in a composer with no prose
opens it aimed at that chat, which wears the target accent while it is
open. Enter applies the highlighted skill there, ⌘↵ starts a chat with it,
⌥↵ a floating one; the footer says which. Tab, or Space after a full name,
moves the skill into the chip and the input takes its instructions, with
the skill's `argument-hint` as the placeholder, so `/review the auth
change ↵` typed without looking still runs. Escape gives the composer back
the slash and what followed it, and a message starting with a slash goes
out as written. The palette's empty state lists one Skills row; the mode
opens with what is used most under Recent.

An empty composer carries a faint `/ skills` hint before its controls. A
skill sent from the palette reads in the transcript as a chip with the
skill's name, then what came with it, pills included: applied to its own
chat, a skill takes the pills waiting in a composer with nothing else
written there; a new chat starts with the skill alone.

### 2026-10-19: Resources shows what Work runs, by who it runs for

Activity Monitor lists Work as a dozen `node`, `bun`, `claude` and `Work
Helper` rows. Work knows which chat, terminal, browser tab or sidebar
module each process is for, so `work:resources` (ADR 0266) lists them
that way: a Total row, Work itself, then each owner, its processes nested
under it. It is a list like any other, added to a sidebar with
`{ id: "resources", source: "work:resources" }`, and in no default layout.

Rows gained a `trend`: a reading's recent history as a 36px line with a
soft area under it, in the accent, the current reading beside it in
tabular figures, a fixed width so the column lines up down the list.
Memory is the row's description, kept whole. A short history starts at
the right edge and grows leftward, so a line never stretches to fill. A
reading near one full core takes the warning tone; nothing else colors it.
Chips draw a trend too, after their label and badges. A chat's row opens
the chat in its own project, whichever project the window shows.
End is the row's hover button, as every row action is: it ends a process
Work started and what it started, and an owner's End or Close goes
through the owner (a tab closes, a terminal ends). Work's own processes
offer nothing to end. Nothing samples unless a section showing the list
is on screen.

### 2026-10-18: The Mac app's icon is drawn as designed; the palette's input grows in place and its arrows move the caret; a terminal opens blank; each question takes its own answer

The installed app's icon looked worse than the dev app's. macOS 26 draws an
app icon from an asset catalog; an app with only an `icns` gets the system's
automatic treatment, which softened the tile's edge and embossed the W into
a brownish glass. The dev app escaped it only because it hands the Dock the
flat PNG while it runs. The icon's source is now `build/icon.icon`, an Icon
Composer icon: the orange fill, a flat W without glass, and for the dark
icon style the W in orange on Work's dark. Its `Assets/W.svg` is the mark
of `build/icon.svg` drawn on Icon Composer's full canvas (as the PWA's
maskable icon draws it): a change to the mark changes both. Packaging
compiles it with Xcode 26's `actool` into the `Assets.car` macOS draws,
with renderings for macOS 13 to 15 in it and an `icns` beside it. The
release job selects a released Xcode 26 and checks the catalog is in the
app; `.github/workflows/desktop-icon.yml` compiles the icon on any pull
request that changes it, fails on `actool`'s warnings, and has macOS 15
read the catalog's renderings for earlier systems.

As the palette's input grew a line, its first line jumped up and slid back.
The gliding frame (`lib/use-gliding-height.ts`) clipped with
`overflow: hidden`, which still makes it a scroll container: Chromium
scrolled it to show the caret on the new line, and the frame's growth
scrolled it back. The composer did the same, unseen because it grows upward
and its text rose anyway. The frame now clips with `overflow: clip`, so
nothing can scroll it and the new line is revealed as the frame grows: what
has not glided into view is clipped, not scrolled to.

↑ and ↓ in the palette always moved the highlight, so a caret on the second
line of a long query could not go back to the first. They move the caret
between the input's lines now, wrapped lines included (`lib/caret-line.ts`
lays the text out in a hidden copy, at the textarea's unrounded width, to
find them), and the highlight from the first line up and the last line
down. A caret that starts a wrapped line is on that line: the copy marks
the character after it, since an empty marker there sits at the end of the
line above. A one-line query is both first and last, so its arrows move
the highlight as before. With Shift, Alt or ⌘ the arrows select or jump in
the text, as the composer's do.

A terminal opened from a chat's command chip showed another terminal's
output, sheared into a staircase, behind its own. ghostty-web's terminals
share one WASM heap, and a new one is handed memory a closed one used
without it being zeroed: every cell the new terminal had not written yet
showed the old one's text, read at the new width, and so did the rows a
terminal grown taller gained. Erasing the screen once was not enough for
those rows. Each terminal tab now loads a WASM instance of its own
(`lib/terminal-ghostty.ts`), which starts on zeroed memory, for about a
megabyte and a few milliseconds. `terminal-ghostty.test.ts` shows the shared
heap's leftovers and a terminal of its own staying blank through every
resize, against the real WASM module.

The question panel dropped its Other row when the composer became the place
for free text (ADR 0195), but one reply cannot answer each of several
questions. Every question has an Other answer again (ADR 0244), typed in the
composer's own input (`components/answer-input.tsx`): it glides taller, a
long paste, a selection, a link or a path becomes a pill, and a pasted image
or file attaches through the dock's own attaching. Enter moves to the next
unanswered question or sends the answers; Escape leaves the box before it
dismisses the questions; moving on, focus follows to the next question,
since the one left turns inert. Sending waits for a file still attaching,
and a file or tab dropped on an answer box goes into it. An answer carries
its pills as a message does, so history draws them in place; core renders
the text pills into what the asking agent reads, and its images follow as a
message the turn takes at its next step, which shows as the answer's card
with the request's pills. The box opens in a wrapper that clips: a
hidden overflow scrolled to the caret as the box opened, and text typed
then landed behind the caret.

`e2e/motion.e2e.ts` presses a real Shift+Enter in the palette and the
composer and checks the first line never leaves the frame's top edge;
`e2e/palette.e2e.ts` walks the arrows through two lines, a wrapped line
(from its start too), Shift and one line; `e2e/tool-permissions.e2e.ts`
answers through Other with typed words, a text pill and an image.

### 2026-10-17: A message sent while the agent works reaches it

A message sent while the agent worked waited, a dashed ghost, until the
whole turn ended; reaching the agent sooner meant ⌘↵, which stopped the
turn, so a quick question cost the agent its place. As in the Claude Code
app, it is sent now (ADR 0240): the bubble lands in the conversation at
once, under it "Not read yet" until the agent takes it in at its next
step, and the line folds away as it does; it opens only after a moment,
so a message the agent reads at once never shows it. Hovering it offers
Interrupt: the agent stops the step it is on and reads the message now, in
the same turn, every message it had not read saying "Stopping to read it"
meanwhile. ⌘↵ still stops the turn and sends a message as the next one.

Queueing is a setting, "Queue messages sent while the agent works" in
the chat dock's settings, off by default; on, messages wait as editable
ghosts as before and the send button's hint says so. A message the palette
sends into a chat follows the same choice; voice always reaches the working
agent, as speaking to it would. A message its turn ends without reading
runs as a turn of its own, gliding from its place to the queue's.

Work's news about the agent's tasks no longer sits queued while the agent
works. It reaches a turn waiting on the person too (the agent reads it once
they answer), and news a stopped turn never read rides the next turn to
start rather than queueing behind it. The screenshot that started this had
a test run's result queued under a working turn although the agent had
already read it: the interrupted turn's steer was still in the warm Claude
Code CLI's own queue, which ran it in the next turn while Work held it to
run again. An interrupt now withdraws what the CLI holds.

`chat-timeline-dom.test.tsx` covers the unread line and Interrupt;
`session-log.integration.test.ts` unread steers, Interrupt and news that
rides the next turn; `warm.native.test.ts` the CLI's queue after an
interrupt; `e2e/agents.e2e.ts` and the PWA's `e2e/pwa.e2e.ts` the whole
path, with queueing on and off.

### 2026-10-17: An opened sidebar takes focus to what is in front; one ring glides between rows

Opening a sidebar left focus where it was, so reaching what was in front
by keyboard meant tabbing through the panel's headers. It now focuses the
row of what is in front, when its list has that row loaded (a file in a
folder nobody opened is not), and the arrows run on from list to list. The
ring shows on arrival when a key opened the sidebar (a shortcut that moves
focus counts as the keyboard) and waits for the first arrow when a press
did.

Each row drew its own ring, around a box that started at the list's edge
while the row's content was indented by a margin, so a child's ring took in
its indent and the highlight did not; the ring on a highlighted row also
sat under the row's own background. A tree now places each row at its
indent (`indent`), and draws one ring over the focused row's box, inside
it and above every row, gliding from row to row as the arrows go.

### 2026-10-17: Lists fade where they continue; a row's chevron ends it; a New Tab takes the chat

[ADR 0237](../../docs/decisions/0237-lists-fade-where-they-continue.md) records
the overflow hint.

A sidebar row with children put its chevron before its icon, so a row
without children (a file beside a folder) sat further left, and the rows
below a childless row read as its children. The chevron now ends the row, as
it ends a section's header and centered under it, after the row's actions;
every row's icon starts in one place and only a child's indent reads as
belonging. The kit's `CollectionItemView` ends its row with its disclosure
too.

Where a list continues past an edge, its content now fades out over the last
24px of that edge instead of being cut there, and only while there is more
that way, following the scroll (the registry's `edge-fade`: a mask from
`cat-edge-fade` in `@catamorphic/ui/styles.css`, so it needs no knowledge of
the surface behind). A scroll timeline would have done it without script,
but its animation counts as running for as long as a list is shown, and what
waits for motion to end (the detached dock's shape, tests) would wait
forever; observing the content's size made the sidebar's collapsibles report
resize loops. So a scroll, the scroller's size and a marker at the content's
end, watched by intersection observers, move the two lengths the mask reads,
at no cost at rest. The sidebar's panel and every section's list, the chat's
conversation (under the header and above the composer, where it was cut at
the composer's border) and the palette's results use it. The sidebar's
scroll thumb is a section's choice now (`scrollbar: true`); none of Work's
sections asks for it. The fade's scroll padding keeps what focus or a jump
brings into view clear of it, the kit's tree included.

Cmd+N, or New chat from the palette, with a New Tab in front opened a
floating chat over the empty page. The chat now opens in that tab: it takes
the New Tab's place in the strip and in a split, and the New Tab closes,
typed into or not. Elsewhere a new chat floats as before, and the dock's +
never takes a New Tab: it starts its chat in the dock.

### 2026-10-17: Chips are a source; pull requests get wide chips

The chips above a chat's composer were one hand-built list: a field per kind,
one look, three of a kind folded into a group, a strip that scrolled sideways,
and the darkest surface token behind them, so dark themes drew them black. Now
they are rows from a source (ADR 0239): `work:chips` by default, or a module
in the project named by workspace.js `chips`, which reads them, ranks, groups
and adds its own with their own buttons. A chip is compact (icon and label, its
buttons over its end under the pointer or focus) or wide (the composer's width,
its description, badges and buttons in view). Every pull request a chat
recorded is a wide chip with its state as icon and color, its size, comments
and checks, read from the person's own GitHub connection; a merge cross-fades
its icon. Agents keep anything else in view by attaching chips under the
session's `chips` metadata.

Chips sit on the raised surface with the hairline border and the theme's tones;
badges are wells. Compact chips flow in lines first and wide ones stack under
them against the composer; past three lines the rest fold behind a dashed "N
more", which unfolds the rail (to two fifths of the window, scrolling only up
and down past that) and becomes "Show less". Chips arrive rising, leave fading
where they stood, and the ones that stay slide to their new place while the
rail's height follows on the same curve. Cmd+J focuses the first chip (a
hidden chat comes back for it), arrows move between chips and lines, Tab
between a chip's buttons, Escape closes an open group and then returns to the
composer. Right-click offers the open modes, a chip's own entries and
Customize chips, which opens a chat with "Help me customize my chat chips."
waiting in its composer.

### 2026-10-16: Google's sign-in admits Work, because a page finds `chrome.app`

Google's sign-in still answered "Couldn't sign you in. This browser or app
may not be secure" on Electron 45 (Chromium 156), so the 2026-10-09 entry's
cause was wrong. Taking the sign-in's first step with a made-up address, on
the same engine with each part of Work's identity switched on or off, found
the gate: a browser that says it is Chrome must have `window.chrome.app`.
Chrome's comes from Chrome's own layer, which Electron does not include, so
Work's `window.chrome` was empty. Work's identity was refused every time and
admitted once `chrome.app` was present, on Chromium 152 too. Client hints on
page loads, `csi`, `loadTimes` and a Firefox user agent changed nothing, and
plain Electron, which names itself, was admitted.

A web page, in a tab, a popup or a tab's embedded frame, now has Chrome's
`window.chrome`: `loadTimes`, `csi` and `app`, matching Chrome's member
order, values, argument errors, which functions construct and that they read
as native code. A daily live check takes the sign-in's first step in a Work
tab and opens an issue when Google refuses Work; real Chrome on the same
runner takes it too, to explain a failure, never to excuse one (ADR 0235). A
full sign-in, through password and 2FA, is checked by hand.

### 2026-10-16: Every sidebar list is a source; the right sidebar starts empty

A section showed one of a dozen hand-written components picked by its
`type`, and those components could do what a person's section could not:
read Work's lists, own verbs and header buttons, draw chat signals and
inspectors. Now a section names a source (`work:tabs`, or a module in the
project), static items, an app or a note (ADR 0234), and one component draws
every list. Work's lists are modules on the person's contract; rows open
their address, and Work's knowledge of a target (a chat's glyph, signals and
live inspector, a page's favicon, the active highlight, how it drags) comes
from that address. Header buttons are header actions, actions may ask for
values (`input`) and report a sentence, and a module reaches Work's lists
(`work.read`, live) and workflows (`work.call`, for secrets and company APIs)
through its section's grants. The right sidebar's content (This session,
Activity, Subsessions, Changes, Proposals) is gone; its data stays as sources,
and Find changed files searches `work:git` in the palette. The default left
sidebar has no chats list (chats are tabs; the palette finds every chat); with
tabs placed in the sidebar, the Tabs section lists `work:tabs`, which a module
can sort, and rows slide when the order changes. The tab strip has no vertical
form any more. Existing profile layouts are rewritten once in the new shape.

### 2026-10-16: A markdown document shows its images

The markdown editor had no images. An image became its alt text, a document
opening on one blanked the window, and saving after any edit wrote the alt
text over the image. An image now shows in place: one in the project (a
path relative to the document, or to the project when it starts with `/`)
is read from it, never a file outside it, and https and inline images load
as they are (a document opened from outside a project shows only those).
While one loads, a chip naming it waits a moment before showing, so a quick
load goes straight to the image; one that cannot show (missing, outside the
project, or plain http) stays a chip with a broken image mark. Images stay
where markdown puts them, inline: a badge sits in its line and an image on
its own fills at most the column. Clicking one selects it, ringed in the
accent, and the grip beside it sits by its top, even over a caption. Saving
keeps each image's markdown as written, except that a reference image
(`![logo][brand]`) is written inline, since the editor keeps no link
definitions.

### 2026-10-15: Chats from Claude Code and Codex sit beside Work's own

People run Claude Code and Codex in terminals and other apps on the same
repositories they open in Work, so one project's history was split across
three apps (issue #240). With **Sync chats from Claude Code** (or Codex)
on in that agent's settings (off by default), those chats appear in the
project's chat list (ADR 0233):

- **They are real chats, continued by their own tool.** Each one is a
  Work session with an `imported` origin, so the chat list, palette,
  search, the phone and agents' session tools see it with nothing of
  their own. The row wears the tool's mark beside its title, and its card
  says where it came from. It opens on the agent whose switch is on, and
  only an agent of that tool continues it: on any other, the composer
  gives way to "You ran this chat in Claude Code. Switch it to a Claude
  Code agent to continue it here." A Claude Code chat resumes Claude
  Code's own session (its records are stored with the import); a Codex
  chat is handed the transcript. Once Work ran a turn in it, the tool's
  file is no longer read into it. Archive hides one for good, even as its
  file grows.
- **They look like Work's own.** A Claude Code transcript runs through the
  same translator as Work's Claude Code turns; a Codex rollout's finished
  items map to the same commands, tool calls and file changes.
- **New chats only, kept current.** Only sessions that start after a tool
  is turned on are imported. Directory watches are hints: a file is read
  once it settles, from where the last read stopped (rollouts reach a
  gigabyte), and only the turns that changed go to core, so an open chat
  follows a CLI that is still working. A last turn reads as open until the
  CLI ends it or goes quiet for ten minutes, and an open one is read again
  then, so a CLI killed mid-step does not leave it spinning. A launch
  reads only the files changed since the last look began, and a session
  that will never import (Work's own, older than the switch, in no
  project) is not kept in memory.
- **Never twice, never shared.** A session Work itself ran (its native id
  is one of Work's threads), a Claude Code side chain, a Codex subagent and
  Codex Desktop's own copies of Claude Code chats are skipped. Imported
  chats stay on this computer: the mirror skips them as it skips incognito
  chats, even once Work continued one; a fork syncs like any chat.

### 2026-10-15: The activity line says what the agent is doing, in its own words

The line beside the spinner said "Thinking...", "Working..." and "Running
code..." through whole turns: a person's chats since early October showed
nothing else. The agent had said more. Claude Code describes every command
it runs ("Read the VAD options and their history"), its summarized
thinking ends on what it does next, and Codex titles each part of its
reasoning, but a title reached the line only until the next step replaced
it with a verb, and a description never did.

The line now says the best a harness gives, as Codex's and Claude Code's
own apps do:

- **The agent's own words**, held through the steps they lead to: Codex's
  latest reasoning title (as Codex keeps it on its status line), and
  Claude Code's thinking title, or its last sentence once the thinking is
  whole, for the steps of that response. A harness hands them to Core with
  each step it starts (`item.started.activity`), so no later step takes
  the line from them; Core follows the batch's events in order. A
  response whose thinking says nothing hands the line back to its steps,
  and a subagent's words and launch ("Delegating: ...") are its own. Only
  a line that is a bold title counts, never a bold lead-in or word.
- **Else the running step's own description**, the words its row shows,
  when it is short and one line (a long one is a tool's data, such as an
  issue's body).
- **Else Work's verb** for the step ("Working with git...").

Notes and steps are unchanged. The agent's messages still say "Writing...",
so a note never shows twice.

### 2026-10-15: A tab in the strip opens wherever it is pressed

Many tabs in the top strip did nothing when clicked. Two causes:

- **A background project dragged the window from under them.** A window
  keeps every project it showed mounted, the others transparent and inert
  under the one in front, and Chromium takes the window's drag areas from
  every element whatever its opacity, inertness or pointer events, each
  over the ones before it. Since the strip's spare room drags the window
  (2026-10-13), a project laid out after the visible one covered every
  visible tab past where its own tabs ended: a press there moved the
  window, middle of the title included. Only the visible project draws
  drag areas now (`-webkit-app-region: initial` on the others; Blink reads
  `none` as `no-drag`, which would cancel the visible ones too).
- **Only the title took a press.** A tab is a 32px pill that lights up
  under the pointer, but only its label, a 16px band around the title,
  opened it. The label now fills the tab inside its border, as a Chrome
  tab does: the tab's padding became the label's, the close button and a
  folded group's expand button sit where they were, and the keyboard ring
  is drawn on the tab with its corners. The hover card, anchored to the
  label, now sits 8px below the whole tab.

### 2026-10-14: A sidebar pushes what Work draws; its lists show their scroll only while it helps

Opening or closing a sidebar beside a chat, a note or Settings slid the
panel over the content and then cross-faded the content into its new place
(ADR 0200), a motion made for web pages, which cannot lay out on every
frame. Content Work draws can, so beside it the sidebar now pushes: the
sidebar's place in the row grows or shrinks on the slide's own transition
(200 ms, the standard curve, the same wait for the items when closing),
the content's edge rides the panel's on every frame, and nothing fades
afterwards. The chrome's sidebar toggle folds away as the panel arrives
and unfolds as it leaves, its gap with it, so the tabs after it move with
the content and land without a jump. Beside a web page, an app's frame, a
terminal or the code editor, the slide and fade stay as they were. The
choice is made at the toggle from what shows; a toggle turned around
mid-slide keeps the motion it has. On the test display a 400-paragraph
note re-wrapping in a narrow window kept every frame under 27 ms while it
was pushed.

The sidebar kept a scrollbar column on its inner edge at all times, and a
long section (Chats, Files) drew a second scrollbar inside it. No sidebar
list keeps a scrollbar now. One thin thumb on the sidebar's outer edge,
the window's edge, stands for whichever list is moving, spanning that
list's own height: it fades in as the list scrolls or as the pointer nears
the edge beside it, can be dragged, and fades out a moment after. Rows sit
evenly with nothing kept for a bar.

### 2026-10-14: A project opens in a window of its own

"Open in another window" sat on each row of the project list, and for a
project the window had already shown it only switched that same window to
it: a window keeps every project it has shown alive behind the one in
front, and a project has one window (ADR 0121). The action now ends the
project's card, below its latest three chats ("Latest chats", the ones its
sidebar lists first; the card no longer lists every ongoing session), with
Cmd-click on its row doing the same. A project the window only keeps in
the background moves to the new window: its tabs, its chats (sent or not,
with what was typed in them) and its running shells go with it, the shells
on this computer taken over with their output rather than restarted (a
remote chat's shell opens again on its server); its pages load again.
A file's unsaved edits live only in its editor, so a project holding some
stays, and the window says which files to save first. A project in front
of a window is already in one, which comes forward. A new window opens a
step down and to the right of the one it came from, is named for its
project, and appears in the macOS Window menu, so Cmd+` goes between them
(ADR 0121, amended).

### 2026-10-14: A message says when it was sent, when asked

Hovering a person's message, or focusing it from the keyboard, shows when
it was sent: beside it on its left, level with its last line, before
Restore to here. It reads as the time today, "Yesterday" and the time, the
date and time earlier this year, and the date in another year, as the
person's locale writes them, and the time's own hint gives the whole date.
It fades with the message's actions and moves nothing. A message still on
its way, or one that was not sent, has no time. A chat left open overnight
says "Yesterday" by morning.

Nothing hovers on a touch screen, and a time beside every message would be
noise, so a tap on a message shows its time until a tap elsewhere. A
narrow column (a phone, a slim pane) has no room beside a long message for
"Yesterday 2:14 PM", so there the time hangs under the message's corner
like a hint. The message's row measures the room beside it, so the time
never covers the message or leaves the conversation.

### 2026-10-14: A block's grip sits on its first line; the format bar leaves as it came

In a markdown document the grip beside a hovered block lined its top up
with the block's top, which suits only a one-line paragraph. On a rule the
line ran along the grip's top edge, and on a heading, a code block, a
table, a quote or a task the grip sat off the words it moves. That was the
extension's placement, so one rule now covers every block: the grip
centers on the block's first line, taken from its first line of text (a
table's first cell, a list item's own words, a code block's first line),
or on its own box when it has no text (a rule, an empty paragraph). It
stays there when an edit moves the block under it.

A rule was a 1px line with nothing around it to hover, and only the line
itself found the grip. It is now a box one and a half lines tall with the
line through its middle: anywhere on it points at the rule, the grip
centers on the line, and the line sits as far from a paragraph, list,
quote, code block or heading as it did. A picked rule shows it, the line
in the accent and the box in a faint wash of it, and no format bar opens
over it, since there is no text to format.

The format bar over a selection rose into place and vanished the moment
the selection went. It now leaves the way it came, sinking 4px and fading
over the same 160ms and curve, in place and not pressable while it goes; a
selection that comes back while it leaves turns it around from where it
is. It still waits for the mouse to lift before it appears, and a press in
the text sends it out.

### 2026-10-14: Values read as values; efforts and models go by their own names

A project's card showed a copy button on every row, so it read as a row
of buttons. A copy button beside a value (a folder, a remote, a sign-in
command, a published link, a webhook URL) now rests hidden in its place
until its row is hovered or holds keyboard focus (`.copy-reveal` inside a
`[data-copyable]` row), and stays while it says the copy landed. Nothing
moves when it shows. Labelled buttons that are a flow's next step (a
device code's Copy, Copy invite link) stay visible.

The effort pickers named levels "Extra-high effort" with descriptions
the harnesses never gave ("Extended reasoning"). Every picker and the
chat's status now show the level as Claude Code and Codex name it, as is:
low, medium, high, xhigh, max. Model pickers title a row by the display
name the harness or provider gives the model and put the id it sends
beside it (an alias, its versioned id). A model without a name of its
own, or whose name only repeats its id (OpenAI's catalog names none),
shows the id once. No name is made up from an id.

### 2026-10-14: A tab's close button shows on hover

Every tab in the top strip kept 20px for its close button, shown or not,
so tabs were wider than their titles and the strip held fewer. Now a tab
is as wide as its icon and title (a short title's tab is 20px narrower;
the widest, a 160px title, is 202px instead of 222px, and `tab-in` /
`tab-out` grow to that). The close button takes no room: it rides over
the end of the label, where the title's padding was, and shows while the
tab is hovered or holds keyboard focus (led by the keyboard, as rings
are), the tab in front included. It fades and grows from 0.8 in 150 ms on
one transition both ways, so a pointer sweeping the strip turns each back
from where it is and nothing beside it moves; the title runs on under it,
its last 12px clearing and the 16px before them fading, instead of
reflowing. Hidden, it lets presses through to the tab; shown, it takes
them at once. A dragged tab hides them all. Where nothing can hover, the
tab in front keeps its button. Tabs in the sidebar keep their row's
close action.

### 2026-10-13: The window drags by the tab strip's empty end; every way out folds the strip

With the macOS window buttons hidden, the project switcher spans the
sidebar's top row, which left only slivers to drag the window by: the tab
strip took presses across the whole chrome row for its tabs and their
drops. Its spare room now drags the window, as Chrome's does: past the
last tab and its +, and before the first too when tabs are centred, with
no width once the tabs fill the strip. While a tab is dragged that room
is the strip's drop target again, so a tab still lands at the end. The
title row drags as before with tabs in the sidebar. The current project's
own card opens beside the sidebar instead of over its toggle.

The strip folded beside a leaving chat in one motion only from its
arrows: Escape, the chat's minimize or close, its bubble and a shortcut
played the chat's exit, then folded. A chat now says when it starts to
leave, so every way out folds the strip while the chat goes. The fold is
worked out where the dock renders, so it no longer renders every chat a
second time a frame into the motion, which stalled the width and padding
while the slide went on; the fold's own preference broadcast no longer
calls each chat either (setting an unchanged state still calls a
component before React skips its children, so an unchanged choice now
sets nothing). Turned back mid-way, the slide takes only the
way back, as CSS shortens the reversed transitions, so both land
together; the chats' ceiling is part of their width, so a wide strip
narrows from the first frame. A drag stops a slide under way, folding
from the keyboard hands focus to the bubble that replaces the arrows (and
back), and both say whether the strip is open. The dock's microphone
choice waits for its preference, like the fold, instead of showing the
default at launch.

### 2026-10-13: An idle Work does nothing

Work used a tenth of a core with nothing happening and much more while a
chat answered. Most of it was polling: the embedded server's workers,
the chat stream feed and every discarded artifact looked for work on
short timers, and the window read its chat lists every two seconds,
flashing a refreshing spinner each time. Now idle means idle (ADR 0229).
The server's pollers slow down when nothing is queued and the writes that
queue work wake them. The window's chat lists, attention and watchers
read again when the main process says chats changed, backed by a
30-second poll; a remote project's lists keep their short polls. A
streamed answer shows its first words at once and is recorded in 100 ms
batches after them.

The rule: nothing runs on a short timer unless something it shows is
changing. A routine read never changes the screen: no refreshing
spinner, no render unless its rows changed (a Refresh press shows on its
own button). Before adding a timer, a poll or an infinite animation,
measure an idle app with the method in [Performance](docs/performance.md).

### 2026-10-13: The strip folds in one motion

Folding the bubble strip stopped halfway. Its chats gave up their width
through a `max-width` falling from 60vw, far above what they used, so the
strip kept its full width for most of the fold and only shrank once its
slide into the corner had landed. Since the microphone came to the dock
(#215) the arrows and the collapsed bubble swap in one place, so nothing
else changes its width meanwhile: the strip slid over at full width, sat
there, then shrank.
It also started each fold from where it last changed spots rather than
where it was, so after chats came or went it first jumped toward the
middle. Folded beside an open chat, it waited for the chat to finish
leaving before it began. Each change it saved came back as a broadcast a
tenth of a second later and rendered every chat again mid-fold.

Now the chats' width goes from what it is to nothing (and back, with
`interpolate-size`), with the rail's gap, so the strip narrows from the
first frame as it slides; the slide starts from where the strip is drawn
and takes the fold's 250 ms; beside an open chat it folds while the chat
leaves (the detached window still waits, as its size follows the chat).
A broadcast that repeats what the dock shows, and a preference other than
the dock's own, no longer render the dock. A folded strip also stays
folded through launch instead of showing open and folding.

### 2026-10-13: Pages ask, over their own tab

A page could not ask anything. `alert` and `confirm` came up in a native
message box that looked nothing like Work and belonged to no tab, `prompt`
threw, a page holding its changes with `beforeunload` silently kept every
reload, address and link from happening, and HTTP sign-ins failed with the
401 page. Now a page asks through Work's own dialog, drawn over its tab's page
as Chrome's tab-modal dialogs are (ADR 0227): the page dims and waits,
while the toolbar, other tabs, the chat and the window carry on. It is
centered in the page like every Work dialog, with the shared buttons,
fields, checkbox and focus ring, and the modal's paired motion (200 ms in,
160 ms out, nothing under reduced motion). A heading names who asks (the
site, or "An embedded page at …" for another site's frame), and the page's
words sit under it as plain text that scrolls when long, so a page cannot
pass them off as Work's. Enter answers OK, Escape Cancel; focus moves into
the dialog from the page and goes back to it.

One dialog shows at a time, in the order the page asked. A tab out of
sight keeps its dialog and wears the waiting question's badge until it is
brought forward, and a page waiting on one does not sleep. From a page's
second dialog on, "Don't let this page show more dialogs" stops them until
it loads again. Going elsewhere or closing the tab answers Cancel.
"Leave site?" (or "Reload site?") holds a reload, a typed address, Back,
the page's own link or form, and closing the tab; Leave goes on with it.
A sign-in names the site and its realm, offers the profile's saved
sign-ins for it, asks again with the username kept when refused, and
offers to save one that worked on the usual password card. Agents read a
waiting dialog in their snapshot and answer it with Enter and Escape, as
a person would; a sign-in is always the person's.

### 2026-10-13: This session, beside the chat

A chat's worktree lived in its status popup and its pull requests nowhere.
Now the right sidebar leads, while a chat is in front, with a "This session"
tab: where the chat works (as the popup says it; a click shows the folder)
and the pull requests its agent recorded, each opening in Work's browser.
Nothing records them natively. A chat's session holds metadata (ADR 0226),
named values agents set with `set_session_metadata`, and the skills tell
agents to keep `pull_requests` there; the same values reach sections a person
writes, whose sources get the chat in front. The tab is a section like any
other in `workspace.js`. It arrives without taking the panel: the default
choice is always a tab that stays, and only the person's own choice brings
it to the front again. A pull request opens as a link in the chat does, in a
tab the chat owns, and the sidebar keeps the chat's session beside what it
opened, so This session stays while the person reads it. The tab's place
grows into the strip, the strip itself opens when it makes a second tab, a
quick change back reverses where it is, and when it leaves while shown the
panels cross-fade to the one that stays; reduced motion settles at once.
Stable tabs slide 16px aside as it arrives, since the strip stays centred:
the slide is the cue that a tab made room, as workspace tabs do.

### 2026-10-13: Chats load as you scroll

The Chats section read 50 chats and offered a Load more button, and every
two-second poll read every page loaded so far, so scrolling made each poll
dearer. It now reads 30 (two and a half of its viewports) and the next page
as the person nears the end, in the shared tree, so any paginated section or
widget does the same: still placeholder rows hold the end, rows arrive with
the list motion, a failed page offers Retry in place. Reading on its own is
bounded by the person's gestures and stops at a page that shows nothing new,
so filtered, sorted and grouped sections never walk the whole history. A
poll of a deep list reads the first page and keeps the rows below where they
meet; everything loaded is read again on a slower beat. The open chat is
never missing from the list: an older one waits past the end.

### 2026-10-12: Menus hold the window; pages get Work's menus

A menu now holds the window while it is open, as a native one does: a
transparent shield under it takes the next press, wherever it lands (a
sidebar row, a web page, an app's frame, the title bar), and that press only
closes the menu; a right-click elsewhere opens that place's menu, as on
macOS. Focus returns to where it was. Pages run in their own process, so a sidebar menu used to
stay open over the page the person clicked. A menu also leaves with the row
it belongs to: closing the sidebar or switching its tab closes it. Every
menu dismisses the same way through `MenuPortal` (ADR 0221); history and
downloads menus used to close only on Escape. Right-click menus open at the
pointer and extend right and down, flipping at the window's edges, instead
of covering the row they came from. Groups are separated by rules, and an
entry that cannot run is dimmed with its reason on hover.

A right-click in a web page shows Work's own menu, drawn by the window at
the click: a link opens in a new tab, to the side or floating, copies or
downloads; an email address sends or copies; a phone number calls or
copies; an image or video opens, downloads or copies; selected text copies,
searches or (on macOS) looks up; a text field offers spelling suggestions
and the edit commands; the page itself goes back, forward, reloads, copies
its address, prints or shows its source. Extensions' items follow, and
Inspect ends every menu. Picking or leaving the menu gives the page its
focus back. Sign-in popups and extension popups and side panels show the
same entries natively, without saved sign-ins or extensions' items.

Every bookmark edits its name and address in one dialog, pinned and
library bookmarks included; bookmark menus no longer list "Open in new
tab" twice.

A page that failed to load keeps its error while it is retried, as Chrome's
error page does: the toolbar shows Stop, Try again shows its spinner, and
the error gives way only when the next page commits or fails in turn.
Retrying used to uncover Chromium's white error page until the page arrived,
a white flash in a dark theme.

A page already open in a tab opens there: a bookmark, a link in a chat or a
page's link to a new window, and a link from another app go to its tab
instead of opening it twice ("Switch to a page's open tab", on by default).
A new tab asked for on purpose still opens one. The palette lists an open
bookmarked page once, under the bookmark's name, found by either's words:
Cmd+P goes to its tab, a New Tab's palette opens it in that new tab.

### 2026-10-11: One chat timeline, the same on the desktop and the phone

The chat the desktop shows is now the registry's chat timeline, installed as
a copy that differs only in its imports (ADR 0218). The phone and any
embedder read a conversation the way the desktop does: notes fold into the
answer's steps once a turn settles, each step says how long it ran, Restore
to here sits on the person's message, a retrying turn counts down with Stop,
a failed send stays where it was with "Send again", and copy and fork sit
beside every settled reply (always shown on a touch screen, where nothing
hovers). What is the desktop's own arrives through the timeline's slots:
attachments read as the composer's pills with their previews, controls name
themselves through ShortcutHint, and PageUp jumps to the previous message.
The steps also gained what the registry had: a failed step says "Failed", a
failed command its exit code, a rename both of its names, and links in a
folded note open like links in a reply.

### 2026-10-11: What the person did not write reads as a row, not a bubble

A chat's bubbles on the right are the person's words, and only theirs (ADR
0217). What another agent, the person's assistant or a workflow sent reads
as a row like a turn's steps: the sender's icon (an agent, the assistant, a
workflow), its name, and the message's first line, with a chevron that opens
the whole message, when it was scheduled, and links to where it came from
(the sending chat, the run, the workflow). Work's news about a task the
agent started reads the same way: the task's icon (a terminal for a
background command, an eye for a watch, the agent for a subsession), colored
by how it stands (green done, red failed, amber waiting on the person,
accent for news while it runs), one line in plain words, the output or
result one click away, and "Open terminal" or "Open chat" at its end. News
that reached the agent while it worked folds into that turn's steps like a
tool's result; news that started a turn heads it; the same task's news in a
row folds into its latest line with a count ("3 times"). A row delivered
without waking the agent says "For the next turn" until the agent reads it.

The queue keeps the person's messages as editable dashed bubbles. Anything
else that waits is one dashed line on the left, "Up next", with the task or
sender and "and 2 more" when news joined it, withdrawn or run now but never
edited. A background command no longer wakes the chat every fifteen seconds
with the same error: a line it reported in the last few minutes is not
news. Session
actions (a workflow archiving or completing the chat) are notices naming
who acted. Restore to here and the up-arrow recall come only from the
person's own messages, and a notification never names a chat.

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
  fold-away animation (`cat-fold-away`), keyed by the note, because a
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
The desktop consumes the same pack; its registry.read capability (ADR 0262) exposes registry items
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
The packaged Mac app draws it from the Icon Composer source `build/icon.icon`,
whose `Assets/W.svg` is the same W on the icon's full canvas.
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

Hermes is a wizard preset of an ACP agent (ADR 0241): Work finds the
person's install (PATH, or `~/.local/bin` where its installer puts it) and
adds an agent that runs `hermes acp`, or shows Hermes' own install and
setup commands with a "Check again". Work never installs it and never asks
for a key: an ACP agent keeps its model and sign-in, and its settings say
where (for Hermes, `hermes model` and `hermes setup`) instead of offering
fields that would do nothing. The app knows Hermes only by its command: a
project's other ACP agents never wear its feather.

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
function (`turnRows`, the registry chat timeline's `turn-rows.ts`); a failed turn's error card and the note
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
  `foldsSteps` (the registry chat timeline's `turn-rows.ts`) names the rule.
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

### 2026-10-10: Talk to Work, and to any chat

A microphone sits in the dock next to the collapse arrows, on their inner
side, and the same microphone sits in every chat's composer beside Send. The
dock's talks with the assistant; a composer's with that chat's own agent,
which carries on in text when voice goes off. A click starts listening: a
ring turns until it really listens, then it lights. The first time, it
downloads its speech models (the ring fills). Listening and speaking run on
the Mac: Kokoro speaks each reply once it is finished, a sentence at a time
as each is made, in each agent's own voice (Heart, Bella, Michael or Fenrir,
set in its settings, else the default one). It stops when the person talks
over it in their own words, or says "stop". The microphone pulses while it
hears; then a wave passes over five dots while the agent works, until its
first sentence is heard, when they become bars following its voice, a bar
per band of speech. Clicking another microphone moves voice there without
reloading anything.

The dock's agent has a name: the assistant. It is Work's built-in assistant
by default, the person's default agent at its harness's default model, or
any of their agents as they set it up, picked in Settings › Voice, the
microphone's menu or the palette; "Create agent…" runs the usual wizard and
makes the new agent the assistant. It looks things up and reads files
itself, saying a few words first, and hands bigger work to sessions so it
stays free to talk. It follows those sessions and hears their notes as they
work, a few at a time, to pass on in its own words; the transcript shows one
quiet line for each. When one of them asks the person something, the
assistant hears it at once and says so, and the person can answer it
right there ("the wide one"); the assistant passes the answer on.
Approvals stay in the chat that asks. Its chat reads every project, so it lives in a project
on this computer and never goes to a server. News that arrives while voice
is off shows as a dot on the dock's microphone, and the next start says it
first.

What voice tells an agent is information, not rules: that the person is
talking by voice and hears each message as it finishes. A person who wants
an agent to talk a certain way says so in that agent's own instructions.
Settings, menus and the palette all write the same profile prefs, and a
live voice follows them. The microphone's menu also learns the person's
voice so everyone else (a television, a colleague, the agent's own voice)
is ignored, switches push to talk (hold ⌥Space), and keeps the microphone in
the dock and in chats or not. ⌘⇧Space turns voice on and off. Out of the
dock, the microphone shrinks away in place and comes back while the
assistant talks; the arrows' menu always offers it back. See ADR 0216.

### 2026-10-11: An open document shows the agent's change

Asked to take care of the open to-dos in a plan, an agent added a meal table
and ticked both items, and the plan open in front of the person stayed as it
was until they switched away and back. The editor read the file once and
refreshed only on window focus, which never comes while the person is in
the window. An editor tab now reads the file again whenever the project's
files change under it, which a settled agent turn announces, unless the
tab holds an unsaved draft: the draft keeps the content it started from, so
saving it still reports the conflict.

Loading that change then marked the file Unsaved: the rich editor reported
its own rewrite of the new markdown (table padding, list markers) as an
edit. Loading content is no longer an edit. Workflow names in the sidebar
also lost a trailing "|" that agents leave when they write
`@displayname Name | @description …` on one line above a workflow.

### 2026-10-11: A first chat says what it waits for; sign-in popups take passkeys

A new person's first Claude chat sat on "Working" for six minutes with
nothing else on screen. Two waits hid behind that word. The first turn on a
computer without Claude Code downloads it and Bun, about 125 MB, and on a
slow connection that is minutes; and when the Claude API fails, Claude Code
retries ten times over about three minutes, and Work dropped every one of
those retries. The activity line now counts the download by the megabyte
("Downloading Claude Code and Bun: 63 of 124 MB"), says when it is setting
them up and starting Claude Code, and names each retry ("The Claude API
returned an error (500). Trying again, attempt 4 of 10") until the API
answers. A download that receives nothing for a minute gives up with a message that
says so, instead of waiting for as long as the app stays open, and Stop ends
a turn that is still downloading at once; the download carries on for the
next turn. A failure to get ready is this computer's, so its words are no
longer rewritten as the provider "having trouble".

Google's "Use your passkey to confirm it's really you" did nothing in the
sign-in popup claude.ai opens: popups are windows of their own, outside the
tab's preload, so their passkey requests went to Chromium alone, which
shows nothing. The browsing session's preload, which every popup runs, now
carries the passkey bridge, and the popup shows the passkey sheet over its
own page in a transparent view, because the workspace's sheet would open
behind it. A saved passkey signs in there; one kept on a phone or in iCloud
Keychain gets the sheet's explanation and Cancel, and the site offers its
other ways in. See ADR 0220.

### 2026-10-12: An agent's terminal lasts as long as its command

A background command the agent stopped kept its chip spinning forever, and
one that finished left an idle shell and its chip on the chat for as long as
the app ran. A terminal now shows as working only while a command runs in
it, however it ends, and an agent's terminal ends with its command: once it
finishes or is stopped, its shell ends and its chip leaves the chat. The
chat's step ("Ran command in background") and its notification stay, and the
agent still reads what it printed. A terminal the person has open as a tab
keeps its last output until they close it, and then it is gone; Cmd+Shift+T
does not offer it back, because there is no process to return to. See ADR
0223.

### 2026-10-13: What an agent shows moves as what a person opens

Talking with Work by voice, the person mostly watches: the agent opens a
page to show them something, closes it, opens the next. Those changes
snapped. An agent focusing a tab set the workspace state itself, so a
split lost its collapse, a floating preview vanished without its exit, and
the content swapped in one frame; a person's open looks smooth only
because the palette fades away over the swap and their own press is the
cue. Now an agent's open goes through what a press on its surface's chip
does (the same split, floating and chip-attention handling), a floating
surface leaves with its exit first, and when the tab in front changes the
content nudges in from that side of the strip with the keyboard cycling's
`pane-in`. A person's click stays instant. Closing works the same way: the
tab's own exit, then its successor arrives from where it sits.

A person talking with a chat by voice is watching it, even with the chat
minimized or the dock's assistant nowhere on screen, so what it shows
opens in front. Only what Work shows opens in front: an open for a project
in the background, or a window that is hidden, is prepared as a tab, and
the agent hears that the person has not seen it yet. Nothing raises a
window. An agent that asks from a session with no chat in the workspace
(a subsession, an automation's chat) no longer borrows whichever chat is
working, which could step that chat out of its tab; what it opens waits as
a tab in the background. A chat steps aside only when it was on screen.

`point_at`'s ring fades in, holds steady and fades out the way it came,
with its note. It used to pulse forever, which the motion contract allows
only for progress, and vanished at once when cleared. A re-render that
rewrites the pointed element's classes (a tab turning active) puts the
ring back steady instead of dropping it. Pointing at something in a closed
sidebar (a row, or a tab while tabs live there) now says the sidebar is
closed instead of glowing off screen.

### 2026-10-13: A project's card says where it lives; every menu closes the same way

Hovering a project in the switcher showed a card of worktrees, pull
requests, change counts and a warning that pull requests could not load.
That warning was the GitHub CLI being off, which it is by default: the
card reported an expected state as a failure. Worktrees and pull requests
belong to a chat now ("This session"), so the card says only where the
project lives: its folder and Git remote, each copyable, its Work server,
and another project's ongoing sessions. It opens at its size: its reads
start while the pointer rests on the project, values still loading hold
their line with a still bar, and a read that fails says "Unavailable" on
its own line. It no longer swaps "…" and "Loading…" for text of another
height while the card resizes. A long path or address keeps its end in
view and shows in full in a hint, never a native tooltip.

The card's ⋯ was a dropdown of its own that nothing closed. It is the app's
menu now, holding the card open under it, and every remaining popover
(project and profile switchers, the extensions and downloads bubbles, a
chat's surface groups) closes through one hook that also hears presses
inside pages, which those missed. Design lint fails a hand-rolled menu.

The switcher's list spans the sidebar's content, whatever the project's
name and the sidebar's width, and a project's card sits beside the whole
list (`ResourceInspector`'s `anchorRef`), clear of its edge and each row's
window button, level with the row it describes. The current project's own
card, from the switcher, sits beside the sidebar, clear of its toggle.

### 2026-10-13: A sign-in that is not really lost does not stop the chat

A person returned to a chat after an hour and its first turn failed in
three seconds with "OAuth access token has expired", and the sign-in card.
The login was healthy: Claude Code refreshes an expired token under a lock
all its processes share, and a CLI that finds it busy (a terminal session
refreshing at the same moment) goes on with the old token. A turn turned
away like that, before any work, on a sign-in whose refresh token is
still good, now waits three seconds saying "Reconnecting to Claude…" and
runs once more on a fresh CLI; the card shows only if that fails too. That
retry's Claude Code writes a debug log under Work's logs (`sign-in/`,
readable by the person alone, five kept) for the next time it happens.

The card's "your message retries by itself once you're back" was true
only after Work's own re-login. Main now runs the failed turn again
whenever the sign-in comes back, however: Work's re-login, a new key in
Settings, `/login` in a terminal or another process refreshing the login,
which main notices by the credentials changing (every few seconds for ten
minutes after the failure, then on focus and wake, for half an hour), or,
for a turn that just failed, by an access token fresh enough that
something refreshed it meanwhile. It does so for chats that are not on
screen too, once per change, three times at most, only for the chat's
latest turn, and only for a person's own message in a top-level chat they
keep: a chat put away, a subsession, or a workflow's turn waits for a
person. See ADR 0228.

### 2026-10-13: The activity line says what the agent does; the steps line keeps time

The turn's clock and "No updates for 45s" sat right after the activity
line's words, so every new activity moved them (by up to 40 px), and a new
activity slid its words up through a blur. A streamed answer pushed the
activity line down a line at a time, a wider step shifted every row's
duration and chevron, and settling dropped the notes' steps in one frame
(the whole conversation jumped by their height).

- **One line, one job.** The activity line is the spinner and what the
  agent does, on one line that never wraps. Nothing sits beside the words
  (withdrawing a message about to start waits at the far end). A new
  activity rides one strong beat of the breathing: the old words fade all
  the way out from wherever their breath was, then the new ones fade in,
  opacity only. The line opens its height when work starts and closes it
  when the turn ends.
- **The steps line keeps time.** The clock, and the silence after 30
  seconds, follow the count on the running turn's latest steps line: the
  work in progress, or the latest note's steps until more work follows.
  While a turn runs, each block of its work shows its line, a lone step's
  included, so the clock always has a home and a second step no longer
  grows a line above the first; once answered, a lone step is its own row
  again. The clock holds the width of its longest reading in seconds or
  minutes (widening smoothly into minutes) and lends the reply none, so
  nothing after it or below it moves. Every steps line is one fixed
  height. An open list longer than the view can scroll the line away; the
  running step's own time stays in view.
- **The first steps line has its place before it comes.** From the moment
  the activity line opens (a message still on its way included) until the
  turn's first steps line, the turn line above it keeps that line's place,
  the column's gap included, with the turn's clock (and, after 30 seconds,
  its silence). The two open as one, and the first steps line takes the
  turn line's place in the same frame: its message fades in where it is,
  without the rise every other message arrives with (a message is never
  simply there, also when work and a note come with it in one late
  frame), an open list opens below it, and the activity line does not
  move. Entrances start on
  the frame that shows them, so on a slow renderer whatever was still
  opening when the steps line came used to push the activity line down
  while its count already read two or three. An opening of the two still
  under way when the steps line comes ends in that frame: a renderer that
  stalls as the turn starts begins the opening only after the stall
  (macOS CI showed it unopened 600 ms on, the first step already there),
  and playing it then slid the activity line 12 px from the steps line
  and moved the conversation with it.
- **Counts change on a beat.** A count and its word fade out and in, and
  their places widen or narrow over 200 ms, so "steps" and the clock slide
  when the count gains a digit.
- **What arrives opens its place, and what leaves closes it.** Work and
  prose joining a running turn grow in, the column's gap above their row
  opening with them (it used to appear at once, a 12 px jump), and prose
  being written follows its height on a short transition. A note folding
  into its answer closes up whole, its steps with it, in the same frame
  its steps join the answer, and leaves when its closing has played, not
  at a fixed time. Its row starts skipping layout out of view only after
  that: the first frame a row skips, it keeps its last size, which the
  folding note would make short (the conversation jumped up and back by
  the note's height for a frame as every such turn settled). The
  activity line closing, its opening settling, and a reply letting go of
  the height it grew by likewise wait for their transitions, which a slow
  renderer starts only with its next frame: a timer alone cut them short
  (a runner stalled for half a second dropped the activity line's height
  in one frame). A row carries its own spacing, which opens with it, and
  its duration and chevron follow its label, not the reply's right edge.
- **The browser holds the latest message still.** While the chat follows
  it, everything but an anchor at the conversation's end opts out of
  scroll anchoring, so whatever grows or shrinks above (a streamed line, a
  step, a fold) keeps the bottom where it is in the same frame, without a
  scroll spring laying the page out every frame. Scrolled up, anchoring
  keeps what the person reads in place. It holds the end only while the
  chat follows: a reader who let go a few pixels short of the end stays
  let go; a press in the conversation, and text selected in it, hold what
  is under the pointer still (a drag that selects lets go); and a touch
  drag, a key that scrolls up, a press on the scrollbar, a jump to an
  earlier message, and a wheel over a code block (which scrolls sideways,
  so the scroll library never took that wheel for the log's) let go even
  mid-stream, where the library's own reading of scroll events is drowned
  out by the growing answer.
- **Only what changes renders.** The clock is the one part that renders
  every second; a beat renders only the text it changes; a turn handed
  back unchanged keeps its rows; a streaming reply parses only its last
  block; a step row renders only when its step reads otherwise, and the
  steps' background commands are handed down again only when a process
  changes. A settled turn out of view skips style and layout, keeping its
  last size, where the browser anchors scrolling (not Safari, where its
  placeholders would move what the person reads). Loops stop where nobody
  sees them (a hidden chat, an activity line scrolled away), clocks wait
  in a hidden chat and catch up as it shows, and the running step no
  longer pulses beside the breathing activity line; a command running in
  the background still does.
- **A chat shown again is as it was.** A lurking chat shown again
  mid-turn, or a chat opened mid-turn, has its activity line open and its
  reply at its height; what arrived while it was hidden is simply there,
  and nothing it held enters again.

`e2e/chat-motion.e2e.ts` samples every frame of a paced turn: the spinner,
the words' box and a folded steps line hold still from before the first
step to the answer, also on a renderer slowed sixfold (as a busy macOS
runner showed, late frames are where entrances overlap), the first steps
line lands where the turn line was, measured from the spinner (a runner
that stalls through the beat before the first step leaves no frame at
rest to compare), also on a renderer that stalls in the turn's first
frames while its motion holds until the first step has landed, the
clock and the silence sit on the steps line, rows
keep their places, the activity line closes before it goes, selected
text holds still under the pointer, a wheel over a code block, PageUp and
the scrollbar take the view from a streaming answer, and an un-lurked
chat's activity line is open from its first frame. `e2e/motion.e2e.ts`
checks every message mounts hidden, also on a renderer slowed fourfold,
where a turn's events land between frames, and on one that stalls as the
turn and the agent's words first show.

### 2026-10-15: The status popup opens at its size; inputs, chats and queued messages move in place; a chat its agent archives just ends; every popup's facts copy; a file's menu acts on the file

The chat's status popup appeared, then grew a line when its Artifacts or
Folder row finished loading, and while it glided taller a scrollbar showed
down its edge wherever the system shows scroll bars. Only the first time:
after that the rows were cached.

- **What it waits for, it shows.** Both rows report their reads pending,
  so the popup opens with them (at most 250ms later, as every inspector
  does). A read that lands measures the panel in the same commit, instead
  of a frame later through its ResizeObserver, so it appears at its height.
  React's development StrictMode tears effects down and sets them up again,
  withdrawing the content's pending reports in between; the panel no
  longer takes that for a landing.
- **Glides clip.** While an inspector's height glides, either way, what has not
  glided into view yet is clipped, not scrolled to. Content taller than the
  window still scrolls once the glide ends.
- **The palette's input glides.** Shift+Enter, a wrapped line or a longer
  query grows the palette's input in a mode or out of one through the same
  frame the composer uses (`lib/use-gliding-height.ts`): 150ms on the
  standard easing.
- **The conversation rides the composer.** As the composer glided taller,
  the chat's view shrank under a scroll position that stayed put: the
  latest words slid under the composer (61px for four lines) and jumped
  back 100ms after the glide. A followed chat's view is now held at its
  end in the frame it shrinks, before paint, so the words move with the
  composer's edge. A reader scrolled up is left where they are. As the
  composer shrinks, the taller view pulls the scroll back to its new end,
  which use-stick-to-bottom read as the person scrolling up: a timer took
  following back, and on macOS it lost the race. Such a scroll is now told
  apart where it lands (up, yet still at the end: the end moved, not the
  person) and marked as the library's own before it reads it, with no
  timer.
- **A chat grows into its tab over what was in front.** Making a floating
  chat a tab (⌘⇧M) switched the content to the chat's tab in the frame the
  chat started to grow: the page behind vanished, leaving the bare
  backdrop around a chat that had just lost its title, border and shadow.
  The page in front now stays painted, and mounted, beneath the chat for
  its 250ms (`useRecedingSurface`), and the card's edge and title ease out
  as it grows.
- **A queued message reads right to left.** Its state (Queued, Held,
  Sending) sits at the bubble's right edge and its controls slide out of
  it to the left on hover, each easing in a soft ground under the pointer.
  Sent now, or sent with ⌘↵ while the agent works (an interrupting turn),
  it looks sent at once ("Sending", nothing to edit; Delete still
  withdraws it) while the agent stops. Then its message takes over where the bubble was, already shown,
  instead of rising in anew below; a ⌘↵ send's pending bubble hands its
  place to the queued one the same way.
- **The project folder says so.** The Changes tree marked the project
  folder's own checkout "Current" beside its branch, which read as a chat's
  worktree when the folder had a feature branch checked out. It says
  "Project folder", as the status popup's Folder row does (ADR 0215: chats
  work there until the person chooses a worktree).
- **A chat its agent archives just ends.** Archiving or closing a chat
  stops its running turn, so a chat whose own agent archived it from
  within that turn read "Interrupted" with Retry above the archive line.
  That turn now ends without either: the line after it says what
  happened, and what it left changed ("Left 2 changed files") still
  shows. A turn another chat's agent or a person stopped still reads as
  interrupted.
- **An action reads as a sentence.** A session action's line names who
  took it and goes on in the action's words: "Claude archived this
  session", not "Claude: Archived this session". A failure, or a summary
  in the agent's own words (a completion), keeps its own sentence after
  the name and a colon.
- **Every popup's facts copy.** A file's, a chat's and a workflow's status
  popups list their facts as the project's popup does, in one row
  (`InspectorFact`): the row the pointer or the keyboard is on shows a
  copy button at its end, on the value's first line, in a place kept
  while it is hidden. It copies the whole value: a file's or workflow's
  full path where the row shows a name, the model without its "default",
  the environment as its picker names it. An action (Manage connections)
  has nothing to copy. A value the kept place truncates (a long model
  name) shows whole in its hint, as the project popup's paths do.
- **A file's menu acts on the file.** Right-clicking a file's tab
  (anywhere on it, its close button included, in the top bar or the
  sidebar) or a link to a file in a chat's reply lists the ways to open
  it, then Copy path, Show in Finder and Copy file. Copy file puts the
  file itself on the clipboard, as Finder's own Copy does, for Finder,
  Mail or Slack to paste; a link to a folder (`notes/`) has no Copy
  file. One menu, the resource menu every tab and link already had, so a
  file's link keeps its ways to open. The menu has closed by the time a
  pick could fail (the file is gone), so a link's or a tab's says why in
  a sheet on the window, as Finder does; a sidebar row says it on the
  row, as its other actions do. A right-click inside an open menu ends
  there: it no longer reaches the tab or link that owns the menu (which
  opened it again at the pointer). That menu's
  leaving no longer waits on its owner to stop re-rendering: the wait
  restarted on every render, so a busy window could keep a closed menu
  over what was right-clicked next.
- **Background work is not timed by its call, nor counted as silence.**
  A background command's or watch's row showed how long the call that
  started it took (1s, 6s) beside "Running in background", read as how
  long the work had run; it shows no time now. While work the turn
  started in the background runs, the turn is quiet by design, as while
  it waits on the person, so "No updates for" is not said.
- **Stop takes the theme's colour.** While the agent works, the
  composer's send button becomes Stop, which was drawn in the inverted
  foreground: white on a dark theme, whatever the theme. It keeps the
  send button's accent now, only its glyph changing, and both use the
  primary button role rather than a recipe of their own.
- **A tab group's eyebrow is a pill.** Two pixels tall, its rounded ends
  read as a cut line; it is three, a pixel above the tab's edge.

`inspector-fact.test.tsx` and `session-inspector.test.tsx` cover the
copies; `file-menu.test.tsx`, `file-clipboard.test.ts` and
`e2e/file-menu.e2e.ts` the file menu; `chat-timeline-live.test.tsx`
background work's quiet; `floating-motion.test.tsx` and `e2e/motion.e2e.ts` cover the chat growing
over what was in front; `chat-timeline.test.tsx` and `e2e/agents.e2e.ts`
the queued message's layout, its Sending look and both hand-overs;
`resource-inspector.test.tsx` covers StrictMode, the measured reveal and the
clipped glide; `e2e/motion.e2e.ts` samples the palette's input growing
through the frames between one line and two; `e2e/chat-motion.e2e.ts`
samples every painted frame of a followed chat while the composer grows
and shrinks; `chat-timeline-embed.test.tsx` covers the archived turn and
the action lines.

### 2026-10-16: Voice hears the person, dictates anywhere, and its keys tap or hold

A television across the room used to talk to the agent: its words were
sent as messages, it cut the agent off, and it ran on into the person's
own turn. Voice now hears the nearest voice that keeps talking. It learns
the person's voice from what they say, with a speaker model that tells
voices apart (ERes2Net), and how loud they speak; a voice that is not
theirs, or far quieter, is not heard and never draws out their turn, and
words the recognizer made of noise are dropped. "Learn my voice" pins it.

Every way in taps or holds. Dictate (⌥Space), Talk to Work (⌘⇧Space) and
Talk to this chat (unbound) are shortcuts that work in any app once Work
is allowed in Accessibility, and a microphone's click and press are the
same: a tap turns voice on or off, a hold talks while held. The push to
talk switch is gone. Nothing said while the models load is lost: the
microphone opens at once, and the models stay loaded a while after.

Dictation writes where the cursor is, in Work or any app: the words show
as they are said, muted with a pulsing dot in a composer, each new word
fading in as an agent's prose does and settling into the text's colour as
the dot goes; typed and retyped only where they changed elsewhere; and
sending them ends it. "Dictation only" makes a microphone's click
dictate. Out of Work, the dock's microphone floats at the bottom of the
screen while voice is on, unless the dock is detached: it eases in and
out, rests left, in the middle or right where it was last dragged (the
spots show while it moves, the dock's way), wears the colours of the
window the person was last in, and its menu moves voice to another open
window's assistant at any time, colours and all, pausing the one it
leaves. A press on it is voice's only once it is a tap or a hold, so a
drag never interrupts the agent. An agent talked to from another app hears
which app and window the person was in, nothing more, and decides whether
what they said was meant to be written there. See ADR 0236.

### 2026-10-18: A restart never waits on work; a person names a chat; sidebar thumbs take lanes; a window comes back smoothly

Restart to update was disabled while an agent or a terminal worked, so a
busy day meant no update. It is never disabled now: Work hands every
working agent back as it quits, and the next launch continues each one
where it left off, the way it does after a crash; terminals and other
processes simply end. The alert says so while work runs. A release
downloaded before Work quit for another reason stays downloaded: the
next check offers Restart, not Download. See ADR 0246.

"Rename…" leads a chat's menu, in the sidebar, on its tab and in the
dock, and the palette's "Rename chat…" names the chat in front. All open
one rename dialog, the small form other actions use, filled with the
current name (empty for an untitled chat). The chat keeps a name its person gave it; an agent that
titles its conversations no longer replaces it. See ADR 0247.

The sidebar itself had no thumb, so a long one gave no sense of where it
was; a thumb for it on the outer edge would have sat where a section's
showed. Thumbs now take lanes: the sidebar's on its outer edge, a
section's that asks for one a lane in, in padding the sidebar widens for
it, never over the sidebar's thumb or a row. Both stay hidden until their list scrolls or the pointer
nears that edge. Every other list still shows only the fade where it
continues, a long note now included. See ADR 0248.

Coming back to a Work window stuttered, most after a while away: every
open project's workspace refetched its stale queries on focus, and the
chat lists read every loaded page again, each reader rendering twice.
Focus now reads nothing by itself; hints and polls already keep the
window current. Only what changes outside Work with no hint opts back
in (a pull request's state, an open file, a pinned note), and a hidden
window catches up once, only if it dropped a hint. A return after 45 s
went from about 183 ms of render work and 7 requests to 21 ms and 2.
See ADR 0249.

A chat whose agent hit its usage limit mid-turn then showed "Caught up on
1 earlier turn" again and again: Work counted a failed turn as unseen by
the agent that did it, so every retry summarized that turn back to it,
words it had already read included. A turn the agent began now counts as
seen however it ended, a turn shows one such line however often it was
retried, and the line says what happened in plain words: "Told the agent
what it missed", as a coding agent's "conversation compacted" does. The
summary itself names a long turn's last few commands instead of every
one. See ADR 0198.

### 2026-10-18: An answered question closes as its answer takes its place

Submitting an answer snapped: the panel dimmed, then vanished in one
frame, the conversation above it jumped as the question's step left, and
the answer faded in after, somewhere else. Now a sent answer shows at
once, as a sent message does (`useAgentChat` reads the request as answered
until the session has it; a refused one asks again): the answer stands
where the question's step was in the same frame, and the panel, inert at
once and unchanged, closes over the next few hundred milliseconds while
the conversation and composer glide into the room it leaves. The close
starts two frames on, after the frame that swapped the answer in, so a
slow commit never shows it as a jump. The answer message the session may
record after it is the same card and does not enter again. See
`docs/chat-state.md` (Agent questions).

### 2026-10-19: Voice yields as the person starts talking; the assistant knows where they are

Talking over the agent used to change nothing until the person finished:
the agent's voice ran on through their whole sentence. Now it goes quiet
about two thirds of a second after they start, paused where it was. Their
words then stop it for good and reach the agent; a cough, its own voice
coming back through the speakers, or someone else in the room lets it
carry on from where it paused, and the bars pick up its voice again. A
"yeah" or "okay" said while it talks is listening, not a turn: it carries
on, and nothing is sent. What the person says reaches an agent at work at
its next step, as a typed message does by default.

The assistant answered about the wrong pull request: its chat is kept in
one project, and it looked at that project's window, not the one the
person was in. Now it is told the project in front of the window the
person is in, sees that window, and its tools look there, or at another
project's window it names. As the person starts speaking, Work keeps what
was on their screen, since it often changes by the time they finish: the
turn describes the screen as it was then, and the agent can load a
picture of it when it needs one. Work pictures its own window when Work
is in front, and from another app the screen, once the person has
allowed Work to record it. See ADR 0265.

### 2026-10-20: A working icon keeps its identity; the tab in front wears the accent; the dock sits level; voice waits its turn

A working chat's icon turned into a spinner, so a tab, a chip or a bubble
lost the one thing that said which chat it was. Now the icon stays and a
small accent spinner rides its top-right corner, the corner the unread
dot and the question badge use, cutting a gap out of the icon beneath it
so it reads on any background (`SignalGlyph`, `.signal-cutout`). It is
the one way a working spinner shows on an icon: tabs, sidebar rows,
chips, bubbles and the collapsed dock bubble alike.

The tab in front had a neutral border on the strip's near black and was
hard to find. It now wears the theme's accent at 60%, as an open chat's
bubble does; the palette's target keeps the full accent, so the two
still read apart.

The dock's microphone sat about two and a half pixels above the bubbles
and made the dock five pixels taller, collapsed or not. Its slot, like a
chat bubble's and the downloads bubble's, was a block around the hint's
inline anchor, so the anchor sat on a line of text and kept room for its
descenders. Every dock slot is now a flex box: no text line, every
control on one centre line.

Voice ended a turn after half a second of silence and so cut the person
off as they paused to think; it now waits 0.8 seconds. A reply that
became ready while they were already talking started over them. It now
waits for them to finish from its first word, and is said once their
words have gone to the agent. See ADR 0267.

### 2026-10-20: Voice lowers other apps' audio while it listens; any reply can be read aloud

Music or a video in another app reached the microphone, and the agent heard
it. Now, on macOS, while voice listens, hears the person or waits on the
agent, other apps' audio dips the way it does on a call, and comes back up
while the agent speaks and when voice turns off. It does so only when voice
listens with the system's microphone: lowering audio opens the system's
input, and opening a Bluetooth headset's would drop it into its call mode.

Every agent reply has a read aloud button beside Copy. It reads the reply
voice on or off: off, in its agent's voice, with the microphone closed.
While it is on its way the button spins, while it plays it is a stop
square and stays in view, and pressed again it stops. See ADR 0268.

### 2026-10-20: A turn that failed on its sign-in while you were away runs again when you are back

A chat's background tasks finished in the night and woke it while every
Claude Code on the Mac was renewing the same expired token; its turns
failed on the sign-in, and the cards were still there in the morning. Main
forgot each failure half an hour after seeing it, and ran again only turns
the person's own message started. Now nothing is forgotten while the Mac
sleeps or its screen is locked. Waking or unlocking it watches every
failure afresh, and runs a turn that failed here again at once when the
sign-in can still refresh: a new Claude Code renews the token itself. A
turn the chat's own task started (a background command, a watch, a
subsession) runs again too. See ADR 0269.

### 2026-10-20: Agents start subagents by naming an agent and how it runs; the assistant uses the same tool

Agents named a delegation route where they meant an agent, and most of
their spawns were refused; a subagent could not be made stronger, cheaper
or read-only. Now `spawn_subsession` names an agent (left out, a copy of
yourself on this chat's model and effort) and its model, effort,
read-only and onward delegation. The agent's settings list whom it may
start and what it may choose: by default, copies of itself on any model.
The voice assistant starts sessions with the same tool. Left without an
agent, it starts the person's own agent, without the assistant's tools; a
session it starts is still handed a brief that leads back to it, and it
still passes on the session's notes. See ADR 0271.

### 2026-10-21: A new profile can bring another profile's settings, and keep them in sync

Setting up a second profile meant redoing the theme, shortcuts, sidebars and
macros by hand, and the two drifted apart. A new profile's welcome screen now
offers "Import from a profile" beside "Import from a browser": pick a profile,
tick Appearance, Workspace, Macros, Keyboard shortcuts or Notifications, and
keep them in sync or take a copy. Kept in sync, both profiles use the same
files, so a change in either shows in both; Settings says so under each shared
category. Profile settings lists what stays in sync, with Stop syncing, which
leaves each profile with what it shows. Agents, passwords and browsing data
always stay with their own profile. See ADR 0272.

### 2026-10-21: A tab dragged onto a chat goes with that chat

A chat's tabs nested under it only when the chat itself opened them; a page
the person opened for that work stayed at the top, and dragging it onto the
chat did nothing. Now, in the sidebar's tabs, a tab dropped on a chat nests
under it, even a chat with nothing under it yet, and becomes one of that
chat's chips, as if the chat had opened it. The top strip does the same: past
a chat tab's leading edge the tab lights up in the accent and takes the drop
inside, while its leading edge still means "before"; a tab dropped among a
group's tabs joins that chat. Closing it hides it behind its chip, and a folded
group opens so the tab stays in sight. Dropped among the top tabs, it leaves
its chat; dropped on another chat, it moves there. A page
an agent is driving, and an agent's or a remote chat's terminal, stay with
their chat and say so; a chat never goes inside another. The tree learned
`acceptsChildren`, so any source's row can take its first child by a drop.
