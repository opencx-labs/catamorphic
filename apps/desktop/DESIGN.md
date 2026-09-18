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
- **Deep links land on exactly one card.** Every palette destination resolves
  to a `data-setting-id` on a single block; category-wide outlines mean the
  catalog id is too coarse.

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

ADR 0127 adds centered or edge-aligned expansion without changing the collapsed
corner. The bubble itself is draggable; dragging never expands it or stores an
absolute resting position. Use restrained settling motion and honor reduced
motion. New and established chats share editable runtime controls; draft choices
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

## Work identity (2026-09-18)

The desktop product is Work, powered by the Catamorphic framework. Its icon is
the orange W in `build/icon.svg`, shared with Work mobile and work.software.
Theme presets are Work Dark and Work Light; the existing palette and motion
contract continue to apply. Packaging, invitations and storage identity follow
[ADR 0146](../../docs/decisions/0146-work-application-identity.md).
