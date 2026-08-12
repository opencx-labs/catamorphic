# Catamorphic Desktop — Design System

The desktop app aims for the OpenCode / Obsidian feel: minimal chrome, dark-first,
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
shared surface is a process bug, not a win. See the 2026-08-08 design-log
entry for how this rule was recovered.

## Principles

1. **Dark-first.** `:root` *is* the dark theme. Light mode is an override behind
   `[data-theme="light"]`, never the default.
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

Type scale (px): 11 (labels/badges), 12 (secondary), 13 (base), 14 (emphasized),
16 (panel titles), 20 (page titles). Base is 13px set on `body`.

## Color tokens

Semantic layer only — components never hardcode hex values.

### Surfaces
| Token | Dark anchor | Role |
|---|---|---|
| `--color-bg` | `#0a0a0b` | app background |
| `--color-bg-raised` | `#101012` | sidebar, cards, panels |
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

- **A button never changes size when it enters a pending/loading state.**
  Use `<PendingButton>` (`components/pending-button.tsx`): it stacks the idle
  and pending labels in one grid cell so the button always reserves the width
  of the widest label, and pending merely toggles visibility. Never swap a
  button's child text on `pending ?` directly — that reflows the layout
  mid-action.
- Pending buttons are also disabled while pending (PendingButton enforces
  this).
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
- Sidebar rows are 28px tall; sidebar width 260px; right panel 380px.
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
   When open uses a keyframe and close uses a transition (the chat dock),
   their durations must be equal — one system, two mechanisms.
5. **Animate before unmount.** Nothing that animated in may vanish
   instantly. Exit pattern: keep the element mounted with an `animate-*-out`
   class (or a transition to the hidden pose), remove it on
   `animationend`/after the duration. Width-collapsing exits swallow their
   flex gap with a negative margin so neighbors slide, never snap
   (`tab-out`, `bubble-out`).
6. **Transitions only on state changes** — hover, focus, expand/collapse,
   enter/exit. Never on load, never ambient.

### Current motion inventory

| Animation | Duration | Pairs with |
|---|---|---|
| `dock-in` (chat dock open) | 250ms | dock collapse transition (250ms) |
| `bubble-in` / `bubble-out` | 200ms | each other |
| `tab-in` / `tab-out` | 200ms / 180ms | each other (exit snappier) |
| `fade-in` / `fade-out` (modal section swap; agent-control overlay) | 200ms | each other (exact mirror; `fade-out` holds its final frame for removal on animationend) |
| `profile-veil-in` / `profile-veil-out` (in-place profile switch) | 200ms | each other (exact mirror) |
| `question-in` (ask_user panel) | 260ms | — |
| `pane-in-left` / `pane-in-right` (keyboard tab cycling) | 200ms | — (content-changed signal on a persistent wrapper; no exit to pair) |
| `bubble-ask` (agent question arrival) | 280ms | — (one-shot nudge on a persistent bubble; no exit to pair) |
| `input-recall` (composer ↑/↓ history) | 150ms | — (content-changed signal on the persistent textarea) |
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

- **No buttons in registry components.** Action chrome (new-chat, run,
  toolbars) is trivial for the embedder to build with hooks and inevitably
  clashes with the host's design. Registry items render data and delegate
  actions through callbacks (`onSelect`, `onNew`-style props are fine; the
  buttons themselves are not).
- **Prefer small composable pieces over all-in-one shells.** The workflow
  surface is composed from `WorkflowCanvas` (graph + minimap + controls),
  `DetailPanel`, and `WorkflowEditorScope` (shared atoms) — not the monolithic
  `WorkflowEditor`. Hosts own the toolbar, save button, and chat placement.

## Theming rules

- New colors enter as a semantic token in **every preset** in
  `src/main/theme.ts` (the source of truth for palettes), in the `:root` +
  `[data-theme=light]` blocks in `styles.css` (the pre-JS first paint), and
  documented here — then used via Tailwind (`bg-bg-raised`, `text-fg-muted`, …).
- The active theme lives in `<userData>/theme.json`
  (`{ preset, overrides }`) — user-global, file-watched, agent-editable.
  ThemeProvider writes each resolved color as an inline CSS variable on
  `<html>`, sets `color-scheme`, and mirrors the appearance to
  `data-theme` for anything keyed on it.
- The `dark` preset in `theme.ts` and the `:root` block in `styles.css`
  must stay identical — `:root` is what paints before JS runs.
- Tokens are mapped into Tailwind 4 via `@theme inline` so utilities and
  registry components pick them up without a config file.

## Design log

Big product/design decisions and their reasoning, newest last. Add an entry
whenever a decision shapes how a surface works or feels — this file is the
memory of *why* the app is the way it is.

### 2026-07-29 — Palette, buttons, and registry decoupling
- Accent is Catamorphic orange (`#f95225` dark / `#d63c0c` light), sampled
  from the zevals logo. **No blue buttons** — primary actions are always
  `bg-accent text-accent-fg`.
- Registry components ship **no buttons or action chrome**; hosts own
  toolbars/save/chat placement. Prefer small composable pieces
  (WorkflowCanvas + DetailPanel + WorkflowEditorScope) over all-in-one shells.
- Animations stay simple and purposeful: 120–250ms, `--ease-standard`, no
  decorative motion.

### 2026-07-30 — Projects live in user-visible folders
- Desktop projects are real folders the user can see (root_path); deleting a
  project unlinks it by default, moving to trash is opt-in. The desktop app
  must never feel like it's hiding the user's work in an opaque store.

### 2026-07-31 — Human-in-the-loop questions (`ask_user`)
- The agent asks structured questions through an `ask_user` tool (AI SDK
  tool without `execute`, so the loop pauses; the answer resumes it as the
  tool result). Questions persist as `awaiting_input` metadata on the
  assistant message — refresh-safe, works across chat surfaces.
- The question panel follows the Claude Code VSCode extension pattern:
  **one tab per question** with a numbered chip that becomes a check when
  answered, animated slide between panels, options carry a label plus a
  description of effects/trade-offs, "Other" free-text is always available,
  single-select auto-advances to the next unanswered question.
- Tool-prompt philosophy: the agent must use the tool (never plain-text
  question lists) both when blocked on a user-owned decision AND when the
  user asks to be interviewed; routine implementation choices pick a stated
  default instead of asking. Recommended option goes first with
  "(Recommended)" appended.

### 2026-07-31 — Chats are workspace tabs, not fullscreen overlays
- The old fullscreen chat mode is gone. A chat expands into a **real
  workspace tab** next to workflows and apps (`ChatMode`: min / partial /
  tab). Rationale: fullscreen-over-everything hid the workspace; tabs make
  chats first-class citizens users can switch between.
- The tab already names the chat, so the in-chat header title is removed in
  tab mode (no duplicated labels); the pop-out/minimize controls float in
  the tab's top-right corner.
- Window chrome is one row: drag region + sidebar toggle + tab strip share
  the 40px top bar. No dead space above tabs.
- In tab mode the timeline scroller spans the full tab (scrollbar at the
  window edge) while content stays a centered `max-w-4xl` column (`max-w-3xl`
  in the floating dock).

### 2026-07-31 — Bubble strip collapse
- Minimized chats live as bubbles in a bottom-center pill. When a chat tab
  is focused the strip **auto-collapses into a single bubble docked at the
  bottom-right**, keeping the composer clear; clicking it slides the pill
  back to center and re-expands. Manual collapse via a chevron button; the
  auto-collapse re-arms each time a chat tab regains focus.
- The collapsed bubble keeps aggregate signal: spinner if any chat is
  sending, unread dot if any chat has unread, and a count badge when
  multiple chats are minimized. Indicators must never be lost by collapsing.
- The chat-tab composer trades clearance with the bubble UI: bottom padding
  when the strip is expanded, side padding when collapsed to the corner.
- The bubble pill **never disappears entirely** while any chat exists — even
  when every chat is a tab, the collapsed corner bubble stays visible.
  Rationale: chat surfaces silently vanishing is disorienting; there must
  always be a visible anchor for "where my chats live". Its indicators
  (spinner/unread) aggregate across ALL chats, including tab-mode ones.

### 2026-07-31 — Escape scope and conversation titles
- Escape only minimizes the **floating** chat dock. Tab-mode chats are real
  workspace tabs and Escape must never dismiss them — tabs are dismissed
  explicitly (close button / minimize control), like in an editor.
- Conversations get real names: the first user message seeds a provisional
  title, and the agent owns a `set_title` tool (prompted to call it once the
  topic is clear, and again on substantial topic shifts). Titles flow from
  `agent_sessions` into the sidebar and tab labels (truncated ~40 chars).
  Generic "Chat N" labels appear only before a session exists.
- Re-title trigger: whenever the current title **no longer describes the
  conversation** (topic moved on, scope changed, title turned out wrong) —
  not only on dramatic topic shifts, but never for minor detours.
- Title changes play a noticeable-but-calm animation (`AnimatedTitle`):
  new text slides in with a ~1.2s accent-color flash in the tab and sidebar,
  then settles. Rationale: the user should notice the agent renamed their
  chat without a toast or modal. This is the one sanctioned exception to
  the "no decorative motion" rule — it's a state-change signal, not decor.

### 2026-07-31 — New-chat default mode, tab exit animation, shortcut hints
- The + (new chat) button opens a **floating partial dock**, not a full
  tab — unless the workspace is completely empty (no tabs, no expanded
  chat), where a full chat tab is the right landing. Rationale: while
  working in a tab/app, a new chat is an aside; stealing the whole
  workspace was disorienting. Empty workspace = chat IS the workspace.
- Workspace tabs animate on close, not just open: the closing tab stays
  mounted while `tab-out` collapses its width (and swallows the flex gap),
  so neighbors slide into place instead of teleporting. Same easing and
  ~duration as `tab-in` so open/close read as one system.
- Keyboard shortcuts that mirror a button get a `ShortcutHint` popover on
  that button (hover, ~500ms delay, shows label + ⌘-key chip) instead of a
  native `title`. First instance: ⌘B ↔ the sidebar toggle. Rule: any new
  button-with-shortcut pair uses ShortcutHint so discovery is uniform.

### 2026-07-31 — Bubbles are minimized chats, X means close
- Simplified the chat surface model: closing a chat tab (X) **closes the
  chat** — it does not fall back to a bubble. Safe because sessions
  persist in the sidebar's Chats list; a closed chat is one click away.
- Clicking a bubble opens the **floating dock**, never a full tab. The
  `lastExpandedMode` memory is gone: bubbles stay bubbles until the user
  explicitly promotes one (expand button on the dock).
- A workspace may have **zero chats** — the strip then shows just the +
  bubble. The old invariant (always ≥1 chat, close button hidden on the
  last bubble) was dropped; "no chats" is a legitimate state and the
  empty-tab hint covers it.
- New chat (+) and opening a sidebar session both open **floating** by
  default, but open as a **full tab** when no tabs are open at all — with
  nothing behind it, the floating dock looks unanchored and the chat is
  effectively the workspace.

### 2026-07-31 — Individual transform transitions, Cmd+W, GitHub clone location
- Transition lists must name `translate`/`scale`/`rotate`, not `transform`:
  Tailwind v4 utilities like `translate-y-4` and `scale-95` set the
  individual CSS properties, which `transition: transform` does NOT cover.
  The dock's collapse looked like a "shift" because translate/scale
  snapped instantly while opacity animated. Swept the app for
  `transition-[...transform...]` and fixed all toggled cases.
- Cmd+W closes the most specific surface: the floating chat dock if one
  is open, else the active workspace tab. Implemented as an app-menu
  accelerator (File → Close Tab) forwarded to the renderer over IPC —
  the default menu's Cmd+W would close the whole window.
- GitHub import gets the same Location picker as project creation; the
  clone destination is user-chosen (defaults to the projects dir) and the
  name field is labeled "Project Name" everywhere.

### 2026-07-31 — ShortcutHint is the standard shortcut popover
- Any button whose action also has a keyboard shortcut gets a
  `ShortcutHint` wrapper (components/shortcut-hint.tsx) — never a native
  `title` and never a bespoke tooltip. One look everywhere: quiet pill
  (bg-overlay, hairline ring, muted label + fainter key), 800ms hover
  delay, 200ms fade+slide in/out, exit animates before unmount.
- Portal-rendered to document.body with fixed positioning measured from
  the anchor. Reason: hosts sit inside overflow-hidden / transformed
  containers (bubble pill, sidebar, tab strip) that clip absolutely-
  positioned popovers — a CSS-only version shipped broken because DOM
  checks passed while pixels were clipped. Verify popovers visually.
- Current coverage: sidebar toggle ⌘B, both New-chat + buttons ⌘T,
  active tab close ✕ ⌘W (active tab only — that is what ⌘W targets),
  question-panel dismiss ✕ Esc.
- **keybindings.json is the single source of truth.** Every shortcut is
  a named action there; handlers match with `matchesBinding(...,
  bindings[action])` and hints render `formatBinding(bindings[action])`.
  Never hardcode a binding literal or a "⌘…" string in a component —
  a rebind must move the handler AND every button's hint together. The
  agent-facing prompt (desktop-config-agent) also generates its action
  list and example JSON from `DEFAULT_KEYBINDINGS`, so it can't drift
  either. Adding a shortcut = add the action to `DEFAULT_KEYBINDINGS`
  (main + renderer mirror) and a label in the Settings map.

### 2026-07-31 — User-global keybindings + agent-configurable app settings
- Keyboard shortcuts live in `<userData>/keybindings.json` — plain JSON,
  user-global (not per project), file-watched: edits from the Settings
  UI, a text editor, or an agent all apply live (menu rebuild + broadcast
  to renderers). Actions: new-chat, toggle-sidebar, close-tab. Binding
  format "Cmd+Shift+T"; invalid entries fall back to defaults.
- Renderer consumes bindings via KeybindingsProvider/useKeybindings;
  ShortcutHint labels derive from the config (formatBinding → ⌘⇧T), so
  hints can never drift from actual bindings. close-tab stays an
  app-menu accelerator (main), the rest are window-level listeners.
- Settings → "Keyboard shortcuts": click a binding, press keys to
  rebind (Esc cancels), instant apply, reset-to-defaults. The file path
  is shown so users/agents know where the JSON lives.
- The chat agent can reconfigure the app: DesktopConfigAgent wraps the
  coding agent, staging a `configuring-catamorphic-desktop` skill and a
  fresh keybindings mirror at `.catamorphic/desktop/keybindings.json` in
  the sandbox before every turn, and applying mirror edits after the
  turn (in a `finally`, before core's draft sync). Mirror commits keep
  config files out of the user's project drafts. Mechanism generalizes:
  future app settings should be added as more mirror files, not new
  bespoke tools.

### 2026-08-01 — Catamorphic is a browser: tabs, address bar, autocomplete
- Browser pages are **workspace tabs** (`kind: "browser"`), rendered as
  `<webview>` guests (not WebContentsViews): they composite into the
  renderer, so app overlays (suggestion dropdown, chat dock, bubbles)
  stack above pages naturally. Browser screens stay mounted but hidden
  on tab switch — unmounting a webview would reload the page.
- The address bar lives **inside the browser tab** (under the tab strip,
  scoped to the page), not in the window chrome. Toolbar = back/forward,
  reload/stop, pill-shaped address field, bookmark star. Cmd+L focuses
  and selects it Chrome-style — including when focus is inside page
  content (main observes the guest's `before-input-event` and forwards).
- Address input resolves Chrome-style: URL-shaped → https, `localhost` →
  http, anything else → Google search. Autocomplete combines a first row
  (search or go-to-URL) with frecency-ranked history matches (per
  profile, `history.json`), plus **inline completion** of the best host
  prefix (applied synchronously to the DOM — async state + RAF corrupts
  fast typing). Never completes while deleting.
- Links that request a new window (`target=_blank` / `window.open`)
  **open as new workspace tabs** — guests have `allowpopups` so the
  main-process `setWindowOpenHandler` can reroute (deny + broadcast).
  Without allowpopups the handler never fires.
- Untrusted pages are fully sandboxed (`sandbox: true`, no node). The
  guest preload talks only to the embedding renderer via `sendToHost`.

### 2026-08-01 — Profiles: Chrome-model identity, projects, and auth
- **Profiles** (`profiles.json`) mirror Chrome's: each owns a persistent
  Chromium session partition (`persist:profile-<id>`) — cookies/logins
  (e.g. a Google session) survive restarts, per profile, verified. Each
  profile also owns its **projects** (sidebar shows only the active
  profile's), a **default project** (first claim; switching profiles
  lands there), and there is a **default profile** (starred in the
  switcher; the app opens into it). Pre-profile projects are lazily
  adopted by the default profile.
- The switcher sits at the **bottom of the sidebar** (color-dot
  identity, star = default, inline "New profile" input). Deleting a
  profile moves its projects to the default profile; the last profile
  can't be deleted.
- Sessions serve the underlying **Chrome UA** (Electron token stripped)
  so Google sign-in flows stay on the normal path. Permission requests
  default to allow only low-risk ones (clipboard-write, fullscreen,
  notifications); device-level permissions are denied until a prompt UI
  exists.
- **Unpacked Chrome extensions** load per profile from
  `profiles/<id>/extensions/*` at session prepare (content scripts run
  in browser tabs — verified). This is the on-ramp for password-manager
  extensions later.

### 2026-08-01 — Passwords: KDBX vault + device auth, Chrome behavior
- Per-profile vault is a standard **KDBX4 database** (kdbxweb — the
  battle-tested KeePass format; hash-wasm provides Argon2). Portable to
  KeePassXC/Strongbox by design; a Google Passwords CSV import lands
  here later. The master key is random, never typed, encrypted via
  `safeStorage` (macOS Keychain) at `profiles/<id>/vault.key`.
- Chrome-mimicking UX, one bar under the toolbar: submit a login form →
  **offer-to-save** (guest preload detects password fields, captures
  submit/click in the capture phase, reports via `sendToHost`); revisit
  a page with a saved login → **offer-to-fill** (fills via native value
  setters + input events so React forms register). Save bar survives
  the post-login navigation as long as the origin matches.
- Revealing/filling a secret is gated by **local device auth** (Touch
  ID via `systemPreferences.promptTouchID`, once per app run per
  profile), mirroring Chrome-on-macOS. Listing origins/usernames is not
  gated. Vault keys never enter the renderer; only the fill payload
  crosses, over the guest's isolated IPC.

### 2026-08-01 — Customizable sidebar (sidebar.js) + bookmarks
- The sidebar layout is user-owned: **`<userData>/sidebar.js`**, a real
  JS file (same philosophy as keybindings.json — plain, agent-editable,
  file-watched, applies live). It evaluates in an isolated `vm` context
  (no require/fs, 250ms timeout) and exports ordered sections. Types:
  built-ins (`workflows`/`apps`/`chats`), `bookmarks`, and `links`
  (static custom links). Attributes: `title`, `collapsed`, and `open`.
- `open` controls click behavior: `"tab"` = always a new browser tab;
  `"replace"` (default for bookmarks/links) = reuse the focused browser
  tab, **falling back to a new tab when the focused tab isn't a browser
  tab**. Verified both modes.
- **Bookmarks are per project** (with one level of folders — deliberately
  shallow), saved via the address-bar star. **Pinning is the one
  cross-project mechanism**: pinning *moves* a bookmark from the project
  scope to a profile-wide pinned list shown at the top of the Bookmarks
  section. Considered making sections/items generally pinnable and
  rejected it — one pinnable thing (the bookmark) keeps the mental
  model simple: project bookmarks belong to the work, pinned bookmarks
  belong to you. Unpinning drops the bookmark into the current project.
- The address-bar **star is a toggle bound to real state**, never a
  fire-and-forget "add": it subscribes to the bookmark store, fills when
  the current URL is saved, and removes on the second click (matching
  pinned entries too, so starring a pinned page can't fork a duplicate).
  URLs compare normalized (trailing slash and #fragment ignored) or the
  star reads unstarred immediately after starring. **A control that
  looks stateful must derive from state** — the first version flashed a
  1.2s fake "starred" animation that always reverted, so every click
  silently appended another copy.

### 2026-08-01 — Cmd+T is Chrome's Cmd+T; the aside gets Cmd+N
- Revises 2026-07-31 "new-chat default mode": **Cmd+T and the tab-strip
  + always open a full chat tab** — with browser tabs in the workspace,
  Cmd+T carries Chrome muscle memory and must never do something
  smaller. The floating quick-chat aside moved to its own binding,
  **Cmd+N** (`new-floating-chat`), which the sidebar/bubble + buttons
  and their hints now advertise. Cmd+N is free because the app is
  single-window — Chrome's "new window" meaning can't collide, and
  "N = new" beats an arbitrary letter. The empty-workspace rule stands:
  a floating chat with nothing behind it opens as a tab anyway.
- A Chrome-style **+ button sits after the last tab** in the strip and
  always creates a new chat tab (hint shows the Cmd+T binding).
- App shortcuts now work while focus is inside webview page content:
  guests' `before-input-event` forwards Cmd-combos to the renderer
  (`browser-guest-key`), which runs them through the same
  user-configurable binding dispatch as window keydowns. Without this,
  any shortcut died silently whenever a page had focus.
- **Cmd+R / Cmd+Shift+R reload the focused browser tab's page** (soft /
  cache-ignoring), from both window focus and inside page content. The
  stock `viewMenu` role was stealing these to reload the whole app —
  replaced with a custom View menu; app force-reload moved to
  **Cmd+Alt+R** ("Reload App"). Rule: inside a browser tab, Chrome's
  shortcuts always win over app-development conveniences.

### 2026-08-01 — Dismissing an empty floating chat closes it
- Escaping or minimizing (−) a floating chat that has **no messages, no
  queued sends, and no typed draft** closes the chat instead of parking
  an empty bubble in the strip. Rationale: an untouched chat holds
  nothing worth restoring; empty bubbles are clutter that the user then
  has to close by hand. A typed-but-unsent draft counts as content and
  still minimizes to a bubble. The − button's label/tooltip switches to
  "Close" when the chat is empty so the behavior is announced, not
  sprung. Tab-mode Escape is unchanged (tab → floating step-down).

### 2026-08-01 — The sidebar is user-authored, and agent-authored
- `sidebar.js` is now the whole sidebar, not a list of toggles: sections
  are `workflows` / `apps` / `chats` / `bookmarks` / `custom`, and the
  array IS the order. Deleting an entry hides that section; a `custom`
  entry invents one with `{ label, url, icon, open, menu }` items
  (`icon` = any lucide-react name).
- **The chat agent can rewrite it.** `sidebar.js` joins keybindings.json
  as a mirror file staged into the sandbox each turn and applied after,
  so "hide workflows", "add a Docs section", "put Copy link on my
  bookmarks" are chat requests. Two guards learned the hard way: each
  mirror applies **independently** (a bad sidebar edit must not swallow
  a good keybindings edit from the same turn), and an agent-written
  config is **rejected unless it evaluates to ≥1 section** — silently
  writing a broken file would collapse the user's sidebar to defaults
  with no explanation. A broken file the *user* writes still falls back
  to defaults, with the parse error logged.
- **One ⋯ menu per row, never a row of icon buttons.** Bookmarks had
  grown pin + delete side by side and every new capability made it
  worse. `SidebarItemRow` renders icon + label + a single hover ⋯, and
  it is shared by bookmarks and config-defined items, so a custom item
  gets identical interaction for free. The menu is **data**
  (`{label, action, danger}`) because the config is evaluated in a vm
  in main and crosses IPC — a callback can't. Actions: `open`,
  `open-tab`, `open-here`, `copy-url`, `pin`, `unpin`, `rename`,
  `remove`; `menu: []` means no ⋯ at all. Menus resolve item → section
  → built-in default.
- Bookmarks stay the *native* store (bookmarks.json, written by the
  address-bar star). The config controls presentation only; the agent
  never hand-writes bookmark data.

### 2026-08-01 — Don't mount a webview during a tab animation
- Opening a bookmark in a new tab looked jaggy because mounting the
  `<webview>` guest and starting its first paint stalls the renderer
  thread ~50ms several times, landing squarely inside the 200ms
  `tab-in` animation. Measured before/after on the same interaction:
  2–3 stalled frames per open → zero. The mount is now deferred past
  the animation, so the unavoidable load cost falls on frames where
  nothing is moving (what a real browser does too).
- **Rule: never start expensive work in the same frames as an entrance
  animation** — defer it past the animation duration. The perceived
  smoothness of the transition matters more than shaving 200ms off a
  page load the user is already waiting on.
- Debugging note: measure the *animation window* specifically
  (`rAF` deltas while `now - t0 < animationMs`), not total frames — a
  post-animation stall during page render is normal and drowns out the
  signal. Verify with a git-stash A/B on the identical interaction;
  three theories (IPC cost, guest-process spawn, the macOS `js-flags`
  JIT workaround) all looked plausible and were all wrong.

### 2026-08-01 — Exit animations must swallow their flex gap
- `bubble-out` now animates `margin-left: 0 → -6px` alongside the width
  collapse, matching the strip's `gap-1.5`. Without it the bubble's own
  width finished animating and the strip then *snapped* the remaining
  6px when React unmounted the element — read as "hangs, then jumps".
  `tab-out` already did this (gap-1 → -4px). **Rule: any exit animation
  inside a flex row with `gap` must animate a trailing negative margin
  equal to the gap**, or the unmount produces a terminal jump.

### 2026-08-01 — Catamorphic presents as Chrome, at every layer
- **A Chromium-engine browser has no way to register as a "legitimate
  browser"** — the supported-browser gate on many sites is pure UA
  sniffing with no vendor allowlist to join. Vivaldi (same engine,
  millions of users) shipped a Chrome UA by default in 2019 for exactly
  this reason, and Edge does the same. Since the engine genuinely is
  Chrome's, presenting as Chrome is the honest, permanent answer — the
  same choice the other Chromium browsers made — not a stopgap.
- The failure mode is **inconsistency between layers**, so all three
  now agree:
  1. **UA string** — `app.userAgentFallback` strips the Electron and
     app tokens once, app-wide, before `ready` (main/index.ts). This
     also feeds Chromium's own brand derivation.
  2. **Request headers** — profile sessions rewrite `Sec-CH-UA` and
     `Sec-CH-UA-Full-Version-List` to Chrome's brand list via
     `webRequest.onBeforeSendHeaders`; Chromium builds these from its
     internal brand table, which no `setUserAgent` call reaches.
  3. **JS** — the guest preload patches `navigator.userAgentData`
     (`brands`, `getHighEntropyValues`) through
     `contextBridge.executeInMainWorld`. Two traps: plain
     `executeJavaScript` runs in the *isolated* world site scripts
     can't see, and the override must go on the **prototype** —
     `navigator.userAgentData` returns a fresh object per access, so
     an own-property definition is discarded on the next read.
  `fullVersionList` reports Google Chrome at the real Chrome version
  (not the `Not;A=Brand` placeholder's 8.0.0.0) — a mismatch there is
  exactly the tell a checker looks for.
- Verified end to end: Google properties serve their normal experience,
  and a live request echo shows UA + Sec-CH-UA agreeing across layers.
- Testing note: **webview guests composite separately and do NOT appear
  in a host-page CDP screenshot** — a blank page area in `drive.mjs shot`
  is a capture artifact, not a broken page. Screenshot the guest's own
  CDP target to see real pixels.

### 2026-08-01 — Themes: every color is a user decision
- The palette became data: **`<userData>/theme.json`** holds
  `{ preset, overrides }`, following the keybindings/sidebar pattern —
  plain JSON, user-global, file-watched, applies live, and staged as an
  agent mirror file (`.catamorphic/desktop/theme.json`) so "make the
  accent purple" is a chat request.
- Four presets ship in `src/main/theme.ts`: **Catamorphic Dark**
  (default — identical to the old hardcoded palette), **Catamorphic
  Light**, **Midnight** (blue-slate dark with a periwinkle accent), and
  **Paper** (warm parchment light). `overrides` layers on top of the
  chosen preset, so "every color is editable" without forking a preset.
- Appearance (dark/light) is **derived from the resolved bg luminance**,
  not declared per preset: a dark preset overridden to a white background
  must still get light scrollbars (`color-scheme`), a light Monaco theme,
  and light `data-theme` styling.
- The renderer applies colors as inline CSS variables on `<html>` —
  `styles.css` keeps the dark palette in `:root` purely as the pre-JS
  first paint, and the `dark` preset must stay byte-identical to it.
  The BrowserWindow `backgroundColor` also follows the theme (set at
  create + on every change) so window open/resize never flashes.
- Settings → Theme: preset swatch cards (bg/raised/accent/fg quadrants)
  plus an "Edit colors…" list with a native color input per token; edits
  write overrides immediately and an accent dot marks overridden tokens.

### 2026-08-02 — The command palette is the front door (Cmd+P / Cmd+T)
- One palette, two hosts: **Cmd+P** overlays it above whatever is on
  screen; **Cmd+T** opens it as the content of a fresh tab — the Chrome
  New-Tab analog. Both are the same component
  (`components/command-palette.tsx`), differing only in chrome and
  commit semantics. The tab-strip + opens the palette tab too.
- **Matching is Superhuman's command-score** (`lib/command-score.ts`),
  ported (~100 lines, MIT) rather than adopting cmdk + Radix — the app
  is deliberately component-library-free, and the matcher IS the
  smoothness: subsequences ("gto proj"), word-boundary bonuses,
  transposition tolerance, keyword/synonym fields per item. Filtering
  is fully synchronous per keystroke over memoized sources; no debounce
  needed at this scale (a few hundred items).
- It searches everything that has a name: sidebar items (workflows,
  apps, chats, bookmarks, custom links), keybinding actions (chips show
  live bindings), projects ("Go to …"), profiles ("Switch to …"),
  recent browsing history (new `browser-history-recent` IPC, frecency
  store already existed), plus a web search/open-URL fallback row that
  reuses the address bar's `resolveInput`.
- **Enter vs Cmd+Enter mirrors the bookmark rule**: overlay Enter
  replaces the current browser tab's page, Cmd+Enter opens a new tab.
  In a palette tab both land in that tab itself — the palette tab is
  consumed by whatever it opens (pure actions like toggle-sidebar leave
  it in place).
- **The input is a textarea, and long input becomes a message.** The
  box grows vertically (`field-sizing-content`); when the query is long
  (>60 chars), multiline, or matches nothing, "Send to agent" takes the
  top slot — a new chat is born with the text attached
  (`ChatDockEntry.pendingMessage`, auto-sent on mount). Overlay: Enter →
  floating chat, Cmd+Enter → chat tab. Palette tab: the tab becomes the
  chat. Cmd+T therefore replaces the old "Cmd+T = new chat tab": the
  palette is a superset — type and hit Send to agent.
- Keybindings follow the established registry convention: `new-tab`
  (Cmd+T) and `command-palette` (Cmd+P) added across the four mirrored
  spots (main + renderer keybindings, settings labels, config-agent
  descriptions). Both work while focus is inside a webview via the
  existing guest-key relay.

### 2026-08-02 — One registry for actions (shared/actions.ts)
- Everything an action needs to exist anywhere — id, label, prose
  description, default binding, palette keywords, palette visibility —
  lives in **`src/shared/actions.ts`** as plain data. Both processes
  import it: main derives the keybinding union/defaults and the config
  agent's action docs; the renderer derives Settings rows and the
  palette's action items. Adding an action = one registry entry + one
  handler.
- Handlers stay in app.tsx (they close over workspace state) but as a
  single `Record<ActionId, () => void>` map consumed by BOTH the
  shortcut dispatcher and the palette — a key press and a palette pick
  can never diverge. The old per-binding if/else chain is gone.
- Icons are deliberately NOT in the registry — lucide components would
  drag React into main-process imports. They live in a renderer-side
  `ACTION_ICONS` lookup with a Zap fallback for unknown ids.
- Plugin-readiness without a plugin system: `ActionDefinition` is an
  open interface with string ids (future plugin actions would be
  namespaced "plugin:action" entries appended at runtime); only
  `BUILTIN_ACTIONS`-derived types assume the set is closed. The
  alternative — a live registry populated by hook registration — was
  rejected because main-process consumers (menu accelerators, agent
  docs) can't read a renderer-side registry.

### 2026-08-03 — Palette intent: implicit ranking + explicit modes
Patterned on what best-in-class palettes converged on (Chrome omnibox
@-shortcuts, Raycast, VS Code quick open, cmdk):

- **Implicit intent is ranking-only, never rerouting.** A full-string
  URL-shaped input (scheme / domain+path / localhost) pins "Open <url>"
  to the first row; long (>60 chars) or multiline input promotes "Send
  to agent" to first. The other options remain right below — the palette
  suggests, the user decides. (Warp is the only tool that auto-reroutes
  natural language, and it needs a denylist + off switch to survive;
  Notion/Chrome offer AI as a row instead.)
- **Explicit modes are chips** (`PALETTE_MODES`: `agent`, `web`). Typing
  `@agent`/`agent` + **Tab or Space** commits the mode: the trigger text
  becomes an accent chip left of the input, the input clears and its
  placeholder switches, and everything typed feeds only that mode.
  Both commit keys deliberately — Chrome removed Space-to-activate in
  2021 and rolled it back after community outrage.
- **Backspace on empty input pops the chip; Escape closes** (the cmdk
  convention: `Escape || (Backspace && !search)` pops one level).
- **`@` on empty/partial input lists the modes as selectable rows**
  (Chrome's @-shortcut pills) — the zero-state IS the discoverability
  surface: click a row or keep typing the trigger.
- **`>` filters to command rows only** (VS Code quick-open muscle
  memory; prefix stays in the text, one-shot).
- **A persistent footer hint bar** (Raycast pattern) advertises `@ modes`
  and `> commands` with keycaps, swapping to `⌫ exit mode` while a chip
  is active. No onboarding tooltips — the footer plus zero-state rows
  teach by being visible at the moment of use.
- Covered by the "palette intent" group in `e2e/app.e2e.ts`.

### 2026-08-04 — Activity indicators are server-truth, and turns can't spin forever
- **An activity indicator must always converge.** The old bubble spinner
  tracked only the client's in-flight send request; a turn that died with
  the process (app quit, crash, dev restart) left its `in_progress`
  assistant row in the DB forever, so reopening the session pulsed
  "Thinking..." and polled every 500ms for eternity.
- Two-part contract:
  1. **Server self-heals**: `AgentSessionsService` tracks turns running in
     this process; a session read that finds an `in_progress` assistant
     message with no live turn settles it as failed ("This response was
     interrupted before it finished."). Reads are the recovery point — no
     background sweeper needed, and a fresh process settles everything on
     first load.
  2. **Clients indicate `isWorking`, not `isSending`**: `useAgentChat`
     exposes `isWorking` = send in flight OR the server reports an
     in-progress turn. Indicators driven by it survive reloads and reflect
     turns this client didn't start; combined with (1) they can never stick.
- **Chat tabs carry the same signals as bubbles**: the tab icon cross-fades
  to a spinner while the agent works (same 200ms stacked-icon treatment as
  the bubble), and a reply landing while the tab is hidden — minimized OR
  behind another tab — marks it unread (accent dot on the icon). "Read"
  means the chat's surface was actually on screen: the floating dock, or
  its tab focused. Background chat tabs no longer count as read.
- Covered by "chat tab activity indicators" in `e2e/app.e2e.ts` and the
  kill-and-relaunch flow in `e2e/recovery.e2e.ts`.

### 2026-08-04 — Profiles own everything; agents are per-profile; harnesses are pluggable

- **A profile is the whole environment.** Beyond the Chromium partition,
  projects, history, and vault it always owned, a profile now owns its
  theme, keyboard shortcuts, sidebar layout, and AI agent roster — all in
  `profiles/<id>/` (`theme.json`, `keybindings.json`, `sidebar.js`,
  `agents.json`). Switching profile switches the entire feel of the app,
  which is the point: work-me and home-me are different people. Legacy
  root-level config files migrate into the default profile once; the
  default profile is named "Default Profile" and is renameable like any
  other (pencil in the profile menu).
- **Switching follows workspace occupancy.** An empty workspace (no tabs,
  no browsers, no chats) switches the window in place under a full-window
  veil — `profile-veil-in`/`-out`, 200ms exact mirrors; the veil is opaque
  at the midpoint so the swap beneath (theme refetch, sidebar, agents,
  projects) is never visible. The sequence is driven by animationend plus a clock fallback — occluded windows throttle animation events, and a stuck opaque veil would be the worst possible failure mode. An occupied workspace means real work: it
  stays put, and the profile opens in its own window (`createWindow` now
  takes a profile; main keeps a webContents→profile map so per-profile
  broadcasts — theme, keybindings, sidebar, agents — reach only that
  profile's windows, and the app menu follows the focused window).
- **Agents are named configurations of a harness.** Three harnesses:
  `ai-sdk` ("Built-in": the sandboxed AI-SDK tool loop with draft
  sync-back, on an Anthropic, OpenAI, or OpenRouter model),
  `claude-code` (the Claude Code CLI on this machine), and `codex` (the
  Codex CLI). A profile can hold several — two Claude Code agents on
  different accounts and a Codex, say. Account auth isolates credentials
  per agent through a private home dir (`agent-homes/<id>` as
  CLAUDE_CONFIG_DIR / CODEX_HOME); API keys encrypt via safeStorage.
  Host harnesses work directly in the project's folder (their own
  runtimes provide the isolation: Codex's workspace-write sandbox,
  Claude Code's permission allowlist); the built-in agent keeps the
  dev-sandbox + uncommitted-draft flow. Core routes sessions through a
  `CodingAgentRegistry` resolved live per turn — adding an agent in
  Settings needs no server restart (ADR 0038).
- **The palette is where agents are switched.** Three registry commands:
  "Change default agent…" (profile-wide), "Switch agent for this chat…"
  (listed only while a chat is focused; the session's next turn runs on
  the new agent), and "Change model effort…" (focused chat's session, or
  the default agent when none is focused; low/medium/high maps onto each
  harness's native reasoning knob). They open palette **pickers** — the
  same chip vocabulary as the `@` modes, one question per chip, Backspace
  pops out. Session-scoped commands appearing only when a session is
  focused is the palette's first context-sensitive visibility rule; the
  precedent for future scoped commands. Scoped commands also **point at
  their target while highlighted**: selecting "Switch agent for this
  chat…" / "Change model effort…" accents the focused dock's border (or
  the chat's tab), and "Close tab" accents whatever it would close — the
  same border-color transition the surfaces already own, no new motion.
- **One setup wizard behind every entry point.** Agent-less profiles get
  the wizard auto-opened as a real, closable tab (closing it skips setup);
  starting a chat with no agents summons the same wizard as a modal; and
  Settings' "Add agent" plus the "Set up a new agent…" palette command
  open it too. The CLI harnesses default to `local` auth — the machine's
  existing `claude login` / `codex login` is inherited with zero
  configuration (Codex offers "Sign in with ChatGPT" when absent); API
  keys are a separate explicit option, and the zero-friction path is
  last: "Continue with free models" runs OpenRouter's browser PKCE flow,
  so the user approves once and never pastes a key. No model ids are pinned in
  code: an OpenRouter agent with no model resolves to the catalog's
  current best free model (newest free model with a ≥32k context), and
  the Settings model field for OpenRouter is a searchable selector over
  the live catalog with "Best free model (automatic)" as the first row.
- **Import is "from other browsers", not "from Chrome".** A generic
  Chromium importer (Chrome, Edge, Brave, Arc, Chromium) reads Local
  State profiles + Bookmarks files; Settings lets each source profile
  import into the current profile or become a new Catamorphic profile.
  Bookmarks land as pinned bookmarks (folders flatten — pinned is the
  bookmarks-bar analog); re-import is idempotent by URL.

### 2026-08-05 — Terminal and editor tabs (libghostty in the workspace)
- Two new tab kinds join the workspace: **terminal** and **editor**. Both
  follow the browser-tab precedent — a per-tab entry array on the
  workspace (`terminals` / `editors`), derived `WorkspaceTab`s, and
  content that **stays mounted while hidden** (unmounting a terminal
  kills the shell; keeping editors mounted preserves undo history and
  unsaved drafts).
- **The terminal is Ghostty, not xterm.js.** Emulation runs in-renderer
  via `ghostty-web` — libghostty-vt (Ghostty's VT parser/state core)
  compiled to WASM (~420 KB, inlined in the bundle) with a canvas
  renderer and Ghostty's real key encoder. The PTY lives in main
  (`main/terminal.ts`, `@lydell/node-pty` — prebuilt N-API binaries, no
  Electron rebuild) and streams over `catamorphic:terminal-*` IPC.
  Sessions are addressed by id, bound to their window, and reaped on
  window close and app quit. Rationale: the same battle-tested VT core as
  the native Ghostty app, with none of xterm.js's Unicode/grapheme gaps.
- Terminal shells are **login shells cwd'd to the project root** (the
  same `projectRoots` semantic host-execution agents use). The tab label
  follows the shell's OSC title; the shell exiting closes the tab.
  `Ctrl+\`` opens a new terminal (VS Code muscle memory). The terminal
  theme derives from the app theme tokens (`bg-inset`, `fg`, accent
  cursor/selection); the ANSI palette stays Ghostty's.
- **App shortcuts beat the shell.** ghostty-web's key handler
  stopPropagation()s every non-printable keydown, which would eat Cmd+W,
  Cmd+T, Ctrl+`… while a terminal is focused. A custom key event handler
  claims exactly the keys bound in the app's keybindings registry so they
  bubble to the window-level dispatcher; everything else goes to the PTY.
  Also: Chromium paints the hidden input textarea's caret even at
  opacity 0 — `caret-color: transparent`, or a phantom caret blinks at
  the terminal's top-left.
- **The editor is one file per tab, fronted by quick-open.** A new editor
  tab greets with a palette-style file picker (command-score over the
  project file list); picking a file mounts Monaco (already self-hosted
  for workflows) with the language inferred from the extension. Cmd+S and
  a Save button write through the embedded server's file API. Unsaved
  drafts survive switching files within the tab and surface as the same
  accent dot chats use for unread — the tab label is the file's basename.
- CSP note: `script-src` gains `'wasm-unsafe-eval'` (WebAssembly.compile
  for the ghostty-web module) and `connect-src` gains `data:` (the WASM
  ships as an inlined data: URL). Both are narrow, local-only allowances.

### 2026-08-05 — Chat surface shortcuts, and external closes must animate
- **Cmd+M minimizes/restores the active chat** (floating dock ↔ bubble),
  falling back to the most recent chat so restoring works with nothing
  focused. **Cmd+Shift+M expands it into a workspace tab.** Both live in
  the shared action registry (palette rows + Settings + rebindable). The
  Window menu's stock `minimize` role was replaced with a plain click
  item: its built-in Cmd+M accelerator would have swallowed the shortcut
  at the menu layer before the renderer ever saw it.
- **Every close path plays the exit animation.** Escape already collapsed
  the floating dock over 250ms; Cmd+W (close-surface) used to unmount it
  mid-frame. Docks now register their animated close with the host
  (`registerClose`), and `closeActiveSurface` goes through it — one
  motion contract regardless of which key closed the surface.

### 2026-08-05 — Keyboard navigation between chats and tabs
- **Cmd+, / Cmd+. cycle the floating dock through the non-tab chats** in
  bubble-strip order (wrapping). No new motion invented: the outgoing
  dock plays its collapse while the incoming plays `dock-in` — the swap
  narrates itself with the vocabulary the docks already own. With no dock
  open, Cmd+. opens the first chat, Cmd+, the last.
- **Cmd+[ / Cmd+] cycle workspace tabs** in strip order (wrapping). The
  content pane nudges in 14px from the direction of travel
  (`pane-in-left/right`, 200ms) — a content-changed signal on a wrapper
  that never unmounts, in the same class as `title-change`: no exit
  animation to pair because nothing enters or leaves the DOM.
  Click-switching stays instant; only deliberate keyboard cycling
  narrates direction. Chat tabs keep their own dock motion instead.
- Caveats accepted deliberately: Cmd+[ / Cmd+] shadow Monaco's
  indent/outdent while an editor has focus (the editor wins there), and
  Cmd+, is free because the app has no Preferences accelerator.

### 2026-08-05 — Tiling and chat surfaces (tab groups, the Catamorphic way)
- **Tab groups anchor on chats, not colors.** Researched Arc (split views
  as first-class sidebar entities, folders, Cmd+Shift+Plus) and Linear
  (keyboard-first peek of related items). Chrome-style colored groups
  don't fit a workspace whose tabs already have an owner: the natural
  group is *the agent conversation*. Tabs born from a chat — pages the
  agent linked, files it changed, terminals for its work — carry a
  `chatLocalId` and appear on that chat's **surfaces rail**: chips above
  the composer (favicon/kind icon + label). Click opens the tab; the
  split button or ⌘-click tiles it **to the right of the current view**.
  A dashed "+ Terminal" chip opens a project terminal attached to the
  chat. The rail appears once a conversation is under way.
- **Attachment sources today:** links clicked in agent messages (the
  timeline's new `onLinkClick` — which also stops raw anchors from
  navigating the app window), changed-file chips (`onFileClick` opens the
  file in an attached editor), and the rail's terminal button. The same
  `chatLocalId` field is the hook for agent-driven tab opening later.
- **Tiling is one split, not a window manager.** `split: {leftKey,
  rightKey}` on the workspace; every pane keeps its absolute-positioned
  DOM node (webviews and terminals never remount) and just gets a
  half-width slot. Cmd+\ tiles the active tab with the previously focused
  one; again unsplits. Clicking a tab outside the split replaces the
  focused pane (Arc's model); cycling (Cmd+[/]) exits the split; closing
  a pane collapses to its partner. The split renders only while valid —
  any mutation that breaks it falls back to the single view, so no state
  updater needs split awareness. In the strip, the unfocused pane's tab
  is raised like the active one but with muted text.
- Deliberate v1 limits: two panes, 50/50, no drag-resize; clicks inside a
  webview don't focus its pane (webview events don't bubble — use the
  address bar or tab strip).

### 2026-08-05 — Split/groups follow-up: resize, drag, group folding, link flavors
- **Activity indicator is now truly server-truth.** The turn runs inside
  the send request; if that response stalls after the turn's messages are
  persisted, the old `isSending || pending` computation spun forever.
  `useAgentChat` now lets a settled server state (completed assistant
  reply, nothing optimistic or queued) override a stuck request.
- **The surfaces rail only shows real surfaces.** The "+ Terminal"
  affordance moved into the chat's header controls — which now sit in a
  snug bordered pill (bg-raised/95 + blur) so they never dissolve into
  timeline content scrolled beneath them.
- **Link clicks in agent messages follow the palette's grammar** (↵
  open / ⌘↵ new tab, extended with a side commit): plain click opens —
  the page takes the view and a fullscreen chat steps down to the
  floating dock; ⌘-click opens a new tab with the chat untouched;
  ⌘⇧-click tiles the page to the right of the current view. The palette
  itself gained the same third gear: ⌘⇧↵ opens URL rows (addresses,
  bookmarks, history) to the side, advertised in the footer hints.
  Chat-control buttons now use ShortcutHint (the app-standard tooltip)
  instead of native titles; the terminal button was dropped from the
  pill — attached terminals come from agents, not chrome.
- **A split pair merges in the strip.** When the two tiled tabs sit next
  to each other, their facing corners square off, the inner borders and
  the gap collapse — one bubble, two labels (bubbles merging). Non-
  adjacent pairs keep the raised-companion styling.
- **Splits resize.** `split.ratio` + a 7px drag handle on the divider
  (transparent, accent line on hover); a full-region overlay during the
  drag keeps webviews from eating the mousemoves. Every split pane offers
  "Full width" — in the browser toolbar right of the star, as a floating
  pill on other panes, in the chat's control pill for chat tabs.
- **Groups fold.** Attached tabs cluster after their chat tab with a
  2px accent/40 top border; a chevron at the group's end folds them under
  the parent (members play tab-out), which then shows a »N badge that
  unfolds them (tab-in). Folding away the active tab focuses the chat.
- **Tabs drag.** The strip reorders by drag (`tabOrder` on the workspace;
  groups travel with their parent and stay contiguous), and dragging a
  tab over the content area offers left/right drop zones that tile it to
  that side. mergeRendered now follows the INCOMING tab order so reorders
  actually move rows; exiting tabs still hold their old spot while
  animating out.

### 2026-08-06 — Launch shows one composed frame
- The window opens hidden (`show: false` + `ready-to-show`), the
  pre-server state is a silent themed backdrop (no "Starting…" flash),
  and a **boot veil** covers the workspace until profiles, agents, the
  sidebar config, and the project list have all loaded — then it fades
  (250ms). Launch presents a single finished frame instead of chrome
  popping in piecemeal. An 8s failsafe reveals regardless, so a wedged
  query can never hold the app hostage.

### 2026-08-06 — Agents see and drive the workspace
- **One bridge, every harness.** Chat agents get workspace tools —
  `workspace_overview` / `read_tab` (discover and expand any open tab,
  chat transcript, or sidebar item), `open_browser` / `browser_snapshot` /
  `browser_act` (real tabs in the user's profile, chrome-devtools-mcp
  grammar: snapshot → uids → act), `run_terminal` / `read_terminal` /
  `write_terminal`, and `surface_control` (release / reclaim / close).
  They're defined once as harness-neutral `ExtraTool`s over the main-
  process `WorkspaceBridge`: the ai-sdk harness mounts them beside its
  built-ins; Claude Code gets them as an in-process SDK MCP server
  (`mcp__workspace__*`, pre-allowlisted) — its native tool loop drives
  our embedded browser the way it would drive chrome-devtools-mcp.
  Codex has no tool hook yet and gets awareness only.
- **Every turn opens with `<workspace_context>`.** A provider decorator
  (`WorkspaceContextAgent`) snapshots the live overview — active tab
  marked "the user is looking at this", running terminals, other chats,
  sidebar shortcuts — and prepends it at the provider boundary, so the
  stored transcript stays clean but "this page" always resolves. A chat
  floated over a web tab is context-aware from its first message. The
  same decorator appends the workspace playbook (tool grammar + handoff
  etiquette) to the system prompt.
- **Control is a visible handoff.** Agent-opened surfaces are watchable
  live (webviews stay mounted; agent terminals broadcast + replay their
  buffer) but interaction-blocked behind a hairline accent ring and one
  pill: "Agent is working — Take over". Taking over makes further agent
  actions on that surface *fail with an explanation* — the agent decides
  to wait, work around, or `reclaim` (the playbook says: only when the
  task requires it, ask if the user is mid-flight). Release hands the tab
  back; close also kills an agent terminal's process — nothing invisible
  keeps running. Page actions flash an accent glow on the element the
  agent touches, so watching feels like watching, not wondering.
- **Attribution over heuristics.** `StartSessionOpts.sessionId` now
  carries the chat's server id into harness tools, so a spawned surface
  chips onto the chat that actually spawned it (mid-turn heuristic kept
  as fallback). User terminals report their PTY session id, so agents
  can *read* any terminal the user sees; writing stays limited to
  agent-owned ones.
- Also: the terminal cursor regression (always hollow) — focus tracking
  listened on ghostty-web's clipboard textarea, but focus really lands on
  the contenteditable container (term.focus(), tab-focus) or the textarea
  (canvas clicks). `focusin`/`focusout` on the wrapper covers both.

### 2026-08-06 — Chat: recoverable errors, queueing, media, markers
- **Errors are cards with a way out, not dead ends.** Failed turns render
  as an error card carrying the friendly classified message
  (`server/agent-errors.ts`: auth / rate-limit / unavailable /
  model-incompat) plus the actions that fix it: **Retry** re-runs the
  turn *in place* — the failed row flips back to in-progress, no
  duplicated user message (`retryTurn` on the harness when it has one;
  re-send fallback otherwise; model-incompat retries strip stale
  reasoning signatures). Auth failures on account-auth agents add a
  one-click **Reconnect** (OpenRouter PKCE / CLI re-login). Transient
  failures (rate limit, provider down) **auto-retry with backoff** —
  5s → 15s → 30s → every 60s, server-side, survives the dock closing —
  with a live "Retrying in Ns" ticker and Retry-now. Interrupts are not
  errors: partial text stays, closed by a quiet centered "Interrupted"
  divider.
- **No name tags.** User bubbles hug the right, agent prose the left —
  the sides carry the roles. Agent/effort switches leave a centered
  hairline marker ("Switched to X") via system rows from core.
- **The queue is visible, editable conversation.** Messages sent
  mid-turn stack at the end of the chat as dashed ghost bubbles
  (right-aligned, QUEUED tag). Each is editable inline (editing HOLDS
  its dispatch — the turn ends, the queue waits for the commit),
  deletable (animated out), and promotable: **send-now** interrupts the
  running turn and jumps the line, as does **⌘↵** from the composer.
  Queues >2 collapse behind a "+N more queued" pill. Interrupt is a
  real cross-harness signal (AbortController in ai-sdk/claude-code) and
  is latched in core so an interrupt during anchoring — before any
  provider signal exists — still cancels the turn.
- **Media rides the composer.** Paste images/documents (PDF, text,
  CSV, JSON ≤10MB) straight into the input — chips with thumbnails,
  removable, sent with the message and rendered in the timeline.
  Capability-gated per agent (`accepts` on the roster): Anthropic
  image+pdf, other API providers image, Claude Code image+document via
  temp files its Read tool opens, Codex none (composer says text-only).

### 2026-08-07 — Reconnect retries; sessions resurrect
- **A successful reconnect retries the failed turn by itself.** The user
  already said what they wanted — fixing credentials must not cost a
  re-send. The dock listens for `agent-login-finished` after its
  Reconnect button starts a login; `ok: true` for that agent fires the
  in-place retry.
- **"Session not found (host restarted?)" is gone as a dead end.**
  In-memory harness sessions (ai-sdk, e2e fake) die with a host restart
  — or a provider rebuild, which is exactly what a credential reconnect
  triggers. Harnesses now report liveness (`hasSession`); core treats a
  lost session as un-anchored and re-anchors with the persisted
  transcript (`StartSessionOpts.history`, capped 40 turns / 32k chars,
  completed turns only — the in-flight user row travels as the message
  itself). The conversation just continues, context intact. Durable
  harnesses (Claude Code) are untouched.

### 2026-08-07 — Terminal chips tell the truth; agents choose terminals
- **The chip spinner tracks the command, not the shell.** Main polls each
  PTY's foreground process (node-pty `process` vs. the shell's name) and
  pushes busy transitions to renderers; a finished `echo` stops spinning
  even though the shell lives on. Agents see the same signal (`busy` on
  read_terminal and workspace_overview) and `run_terminal` now WAITS for
  the command (bounded at ~15s) and returns exactly the output it
  produced — long runs return early with `commandRunning: true`.
- **Agents pick where commands run.** `run_terminal` takes an optional
  `terminalId` (from workspace_overview or a prior run): reuse beats a
  tab per command. Targeting the user's own terminal flips it to
  agent-controlled first (ring + "Take over"), busy terminals refuse
  with advice, and taken-over ones stay refused.
- **Claude Code's Bash is disabled when workspace terminals exist.** Its
  built-in shell runs inside the CLI process — invisible, unmanageable.
  With `disableBash`, every command goes through our terminal tabs: the
  user watches live, can take over, and the app fully intercepts I/O.
  Codex keeps native shell until it grows a tool-injection hook.
- The e2e fake can now drive the REAL workspace toolkit ("terminal:"
  keyed prompts), so chips/busy/targeting are covered by deterministic
  tests instead of manual runs with a live model.

### 2026-08-07 — Identity: the browser is a feature, not the pitch
- Catamorphic drifted from "embeddable workflows-as-code for SaaS" into
  this desktop workspace, and the workspace is the product with momentum.
  The browser **stays** — as the user's daily surface and the agents'
  verification surface — but the evidence (Arc post-mortem, Atlas EOL,
  Chrome share *rising* through the AI-browser wave) says it must never be
  the public positioning. The candidate story is "agents that work on
  visible surfaces you can watch and take over, with local-first state" —
  which is exactly what the WorkspaceBridge + take-over model already
  implements. Two standing constraints that bind design work here:
  (1) agent access to browser surfaces and agent access to the vault must
  stay architecturally separated (prompt-injection → vault takeover is the
  category's worst disclosed incident class); (2) the novelty-tax lesson —
  new concepts need Chrome/VS Code muscle-memory anchors (as Cmd+T, Cmd+L,
  Ctrl+` already do) rather than new mental models.
- `dev:desktop` was fresh only at launch: `@catamorphic/*` dists got
  prebundled into vite's dep cache, so a running app kept serving stale
  package code after a rebuild while apps/desktop source hot-reloaded —
  the mismatch behind several "works after restart" reports. The
  renderer now excludes workspace packages from optimizeDeps (their
  dists are plain ESM) and un-ignores them in the watcher: rebuilding a
  package HMRs the running app with current code, state intact.

### 2026-08-08 — One signal vocabulary for chats; notifications; desktop feel
- **Every chat-as-icon surface speaks the same signal language**
  (`components/chat-signals.tsx`): spinner = working, accent dot = unread,
  pencil = unsent draft (chat composers AND editor tabs' unsaved changes),
  pulsing accent "?" = the agent asked and is waiting. Bubbles, workspace
  tabs, and the collapsed aggregate bubble all render `SignalGlyph` +
  `SignalBadge`; one badge shows at a time (question > unread > draft, all
  yield to the spinner). ChatDock reports `{working, draft, awaitingInput}`
  through one `onSignalsChange`; unread stays host-derived (it needs
  surface visibility).
- **A waiting question is the loudest quiet thing on screen.** The asking
  chat's bubble plays a one-shot `bubble-ask` nudge (scale + radiating
  accent ring, 280ms) so the user knows WHICH agent asked; the "?" badge
  pulses while the question waits (sanctioned loop: the turn is suspended
  — indeterminate until answered).
- **Notifications are opt-out, per profile** (`profiles/<id>/prefs.json`,
  Settings → Notifications): a soft synthesized two-tone chime (WebAudio,
  no assets — "done" falls, "question" rises) when an agent finishes or
  asks, skipped when the chat is front-and-center in a focused window;
  plus a silent OS notification when the window is unfocused, whose click
  focuses the window and reveals the chat.
- **Bubbles identify themselves instantly**: their ShortcutHint tooltip
  shows at ~100ms (new `delay` prop) — a bubble is just an icon, so
  "which chat is this" must not cost the standard 800ms.
- **Desktop selection feel**: app chrome is `user-select: none` (body
  default) with content re-enabled (inputs, contenteditable, the chat
  timeline via `role="log"`); Cmd+A outside an editable field is a no-op
  instead of selecting every label on screen. Monaco, the terminal, and
  webviews keep their own selection behavior.
- **The New Tab page owns focus and teaches shortcuts**: clicking its
  background refocuses the palette input (mousedown-preventDefault, no
  blur), returning to the window lands the caret back in the input
  (guarded so a split neighbor is never robbed), and a faint two-column
  cheat sheet under the panel lists the button-less workhorse bindings
  (⌘M, ⌘⇧M, ⌘\, ⌃`, ⌘⇧T, ⌘]) straight from the live keybindings.

### 2026-08-08 — Terminal truths: Cmd leaks, and scrollback that survives
- **Unbound Cmd-combos never reach the shell.** libghostty's legacy key
  encoding drops the super modifier and TYPES the plain letter (Cmd+D
  wrote a "d" into zsh — the report was "Cmd+D didn't close the tab",
  the truth was the shell never saw EOF). The terminal's key handler now
  swallows every meta-combo it doesn't recognize, except Cmd+C/Cmd+V
  (ghostty's own copy/paste). Shell exit (Ctrl+D, `exit`) closing the
  tab already worked and still does.
- **Reopening a closed terminal keeps its story.** Closed user sessions'
  buffers move to a small main-process morgue (10 entries); Cmd+Shift+T
  prints the dead session's scrollback dim, a "── session ended · new
  shell ──" divider, then a fresh prompt — the output stays readable
  without pretending the shell survived. Replay is SANITIZED plain text
  (`lib/scrollback.ts`, unit-tested): raw ANSI replay is grid-state
  dependent (zsh's prompt marker erases neighbors when replayed cold);
  CR-overwrites and backspaces resolve to final text, escapes drop.
- Terminal buffers are now chunk lists (join-on-read, collapse-on-join)
  — the old `buffer + data` slice churned up to 200KB of copying per
  PTY data event during chatty builds.

### 2026-08-08 — Browser tabs: silent failures now have exits
- The "type a URL, get a stuck white tab, retry until it works" bug was
  three stacked silences: guest attach can fail with no event (now: a
  1.5s watchdog remounts a webview that shows no sign of life, and
  `render-process-gone` remounts crashed guests); `navigate()` silently
  dropped URLs issued before the guest could take them — `loadURL`
  REJECTS on a young webview and the address bar updated anyway (now: a
  pending-URL queue flushes on dom-ready); and a failed profile prepare
  poisoned its cache entry forever (now: prepare is a shared promise,
  deleted on failure, retried by the renderer).
- Main-frame load failures (`did-fail-load`, code ≠ -3) render an
  in-pane error card with the reason and a "Try again" — never again a
  silent white pane with a spinner.
- **Hidden tabs learn they're hidden.** Chromium never tells an
  offscreen webview guest it's not visible, so parked tabs played video
  and polled at full rate. The host now reports tab visibility and the
  guest preload shims `document.visibilityState`/`hidden` (+
  `visibilitychange`) in the page's main world — Chrome-parity
  background behavior; agent-driven tabs are exempt.
- Perf: Monaco moved out of the startup chunk (lazy editor/workflow
  screens — it was ~half the renderer bundle); chat Messages are
  memoized on data props with hashed content keys (a streaming turn
  re-renders the tail, not every message's markdown).

### 2026-08-08 — Chat navigation: jump up, recall, fork, identity
- **"What did I even ask?" is one press.** A ↑ button (bottom-right of
  the timeline, PageUp from the composer) scrolls the nearest user
  message above the view to the top — where its answer starts — and
  walks further up per press. User messages carry `data-user-message`;
  the button slides left when the scroll-to-latest button appears.
- **↑/↓ in the composer recall sent messages** shell-history style: ↑
  from an empty draft steps back, ↓ steps forward and finally restores
  the stashed draft; typing exits recall. Each step plays `input-recall`
  (150ms fade+drop) so the swap reads as an arrival, not a glitch.
- **Conversations fork.** A hover fork button on any assistant reply
  copies the transcript up to that point into a NEW session (same
  agent/effort; `parent_session_id` recorded; marker row + system-prompt
  note make the fork self-aware). The fork opens tiled beside the
  current view, chips onto the parent's surfaces rail (kind "chat",
  GitFork icon), shows the fork glyph wherever chats show icons, and
  carries a back-to-parent button in its control pill (reopens the
  parent by session if it was closed). First turn re-anchors from the
  copied history — the same machinery as host-restart resurrection.
  Editing a PAST message (with file-state undo/redo) was evaluated and
  deliberately dropped: host harnesses (Claude Code/Codex) work in the
  real project folder with no checkpoint substrate we control, and
  conversation-level branching is exactly what forks give.
- **Agents name AND mark their chats.** Beside `set_title`, agents get
  `set_chat_icon` — a workspace ExtraTool (so ai-sdk and Claude Code
  both have it), writing "<name>:<color>" from a curated set
  (`shared/chat-icons.ts`: 30 Linear-style lucide glyphs, 8 colors that
  ride theme tokens where possible) straight through the sessions
  service. The icon shows on bubbles, tabs, the dock header, and the
  sidebar; a custom-iconed TAB keeps a tiny chat/fork marker on the
  glyph's corner so it still reads as a conversation.

### 2026-08-08 — The desktop is the proving ground; enhancements flow upstream
- Canonized as a founding idea (it was implicit and half-enforced): the
  desktop app's job is to feel amazing, and every enhancement that lands on
  a reusable surface gets ported back to the installable components, so
  people embedding Catamorphic inherit the polish. The existing rule
  ("never patch installed files under components/catamorphic/; improve
  upstream in packages/registry") was the maintenance half of this; the
  missing half was the obligation to upstream desktop-grown work.
- The audit that prompted this: the installed chat-timeline had drifted
  714 lines ahead of the registry source (error cards, queueing, media,
  markers all landed desktop-side only); agent-chat had drifted slightly;
  and the floating chat dock, agent-question-panel (ask_user UI),
  chat-signals, pending-button, and shortcut-hint exist only in the app
  despite being exactly what a copilot embedder wants. The port list and a
  drift check are tracked so this cannot silently regress again.

### 2026-08-08 — Media lands however it arrives; terminals obey Cmd+D; tabs explain themselves
- **Attach flows meet the user wherever they are.** Pasting media only
  worked with the caret exactly in the composer textarea; now the WINDOW
  handles paste while a chat is the front surface (text pastes stay
  native — only pastes carrying files are intercepted), files read from
  `DataTransfer.files` with an `items` fallback, and **drag & drop onto
  the chat surface attaches** behind a "Drop to attach" accent cue.
  Verified end-to-end against a live model (image → chips → send →
  timeline → the model described the image).
- **Cmd+D closes the focused terminal.** Revises the previous entry's
  "swallow it": the user's mental model is kill-the-shell, so honor it —
  Cmd+D kills the PTY (the exit event closes the tab; scrollback is
  buried for ⌘⇧T). Main's kill handler now emits the exit event itself:
  the pty callback skips already-deleted sessions, so a kill from a live
  tab previously died silently. Agent-owned terminals are exempt.
- **The take-over pill says who owns the surface and offers both moves**:
  "Agent owns this terminal/page" + a **Go to chat** button (reveals the
  owning conversation) + an accent **Take control**. And a read-only
  terminal's cursor stays **hollow with no blink even when focused** — a
  blinking block promises typing that can't land; Take control focuses
  the terminal, goes solid, and keys land immediately (verified live
  through a real agent-driven sleep).
- **Tab hover cards** (Chrome's pattern): dwelling ~500ms on a tab shows
  a portal card with the FULL title, a per-kind detail line (page URL,
  file path, chat's agent + fork lineage), and the live status line
  ("Agent is working…", "Waiting for your answer", "Unsent draft",
  "New reply"). Disarmed by click/leave/drag; the close button keeps its
  ShortcutHint (cards attach to the tab body only).
- **E2e windows disable background throttling** (`backgroundThrottling:
  false` under CATAMORPHIC_E2E_DATA_DIR). Chromium throttles animation
  events for occluded windows — exactly the veil-fallback lesson — and
  test-runner windows stack behind the terminal, so exit animations
  never fired animationend and the motion suite saw phantom zombies.
  This was the real identity of the "flaky motion trio" AND the
  "pre-existing" agent-switch failure; the suite is green and ~2× faster
  with throttling off. App behavior in real use is unchanged.
- **No harness may burn a model turn to learn its own session id.** The
  claude-code and codex providers used to anchor new sessions with a
  kickoff turn ("Reply with exactly: OK.") — a bare standing instruction
  at the top of every transcript, which the model kept obeying ("How
  about now?" → "OK."). The contract now says `startSession` must not
  talk to the model: claude-code chooses its own UUID (the SDK's
  `options.sessionId`); codex, whose CLI only reveals a thread id once a
  turn starts, returns `providerSessionId: null` and reports the real id
  from the first user turn via a new `session` agent event that core
  persists (never recorded as turn content). Codex's standing
  instructions now ride the first real message in a labeled
  `<session_instructions>` block instead of a turn of their own.
  `ProviderSession` also carries `sessionId`/`projectId` now, which
  dissolved the wrapper-side session→project maps (workspace context and
  profile stores survive host restarts instead of falling back), and the
  never-called `resumeSession` left the provider contract entirely.

### 2026-08-09 — Background work is visible; subagents are surfaces; connectors are one ecosystem
- **Background processes are detected at the cleanest seam each harness
  offers, never papered over.** Claude Code keeps its native background
  machinery (Bash `run_in_background`, TaskOutput/TaskStop — allowed
  now) and the host watches it through SDK PostToolUse hooks: the
  structured tool response's `backgroundTaskId` becomes a `background`
  event the moment a task starts or is stopped. Where terminals are
  available Bash stays disabled (previous entry's rule — commands run in
  watchable tabs), so hooks matter for tool-less installs and for
  TaskStop. Codex gives the model no background tools at all, so the
  provider *detects* instead of intercepts: a command item still
  `in_progress` when the turn ends, or a completed command that
  demonstrably daemonized something (trailing `&`, nohup/setsid, docker
  `-d`, pm2, tmux/screen detach), emits `background` with
  `status: "detected"`. The principle: prefer the harness's own tools
  and observe them; fall back to detection, and say honestly which one
  you're doing (`started` is managed, `detected` is best-effort).
- **Subagents are chat surfaces.** The `AgentEvent` vocabulary gained
  `subagent` (+ `subagentId` attribution on nested activity events).
  Claude Code maps them purely from its stream — the Task/Agent
  tool_use opens one, the answering tool_result closes it, and nested
  tool calls arrive tagged with `parent_tool_use_id`; subagent *text*
  is deliberately dropped (it's the subagent's transcript, not this
  chat's). The rail above the composer shows a chip per subagent
  (spinner while working), and — honoring "chips must open something
  real" — clicking opens an upward popover with that subagent's
  activity feed. Watcher chips (`Radio` icon) work the same and persist
  across turns until an event ends them.
- **Connections are profile infrastructure; agents subscribe.** MCP
  connections live in `profiles/<id>/connections.json` (header/env
  values safeStorage-encrypted, never across the contextBridge — same
  standing rule as the vault split). Each agent carries an assignment:
  `{mode:"all"}` (every current AND future connection — the default) or
  a picked subset; the wizard offers the choice at creation, Settings
  edits it later. The registry resolves the assignment on every lookup
  and the provider cache key includes the resolved MCP surface, so a
  connection edit rebuilds the provider on the next turn while
  model/effort switches still don't.
- **One MCP client, both protocol generations, newest preferred.** The
  new `@catamorphic/mcp` package rides the official v2 SDK
  (`@modelcontextprotocol/client`) with `versionNegotiation: "auto"`:
  it probes `server/discover` and speaks the stateless 2026-07-28
  revision when the server does, falling back to the legacy
  `initialize`-handshake era otherwise. Streamable HTTP is preferred,
  with an SSE-transport fallback for legacy servers. CLI harnesses
  negotiate for themselves — Claude Code gets native `mcpServers`
  config, Codex gets `mcp_servers.*` `--config` overrides — and the
  built-in harness mounts each server's tools as
  `mcp__<server>__<tool>` dynamic tools.
- **Connectors ride two open ecosystems instead of inventing one.**
  Search spans the official MCP Registry (frozen v0.1 API; entries
  carry enough `server.json` metadata to auto-configure transport, url,
  args, and required secrets) and Claude Code / Cowork plugin
  marketplaces (the public `.claude-plugin/marketplace.json` format;
  Anthropic's official marketplaces are Apache-2.0 and searchable by
  default). Installing either lands as profile connections that work
  for EVERY harness; a plugin's MCP servers are lifted out and owned by
  the host (`skipMcpDiscovery`), while Claude Code agents additionally
  load the plugin natively for its skills/agents/commands. A connector
  is never harness-specific in the UI.

### 2026-08-09 — MCP Apps both ways; agents that build, show, and point
- **Our apps and MCP Apps are the same architecture; we bridge dialects,
  we don't switch sides.** The standard (`io.modelcontextprotocol/ui`,
  first official MCP extension) is our AppMount design with tools where
  we have workflows. The rule from the connectors work stands: adopt the
  standard's vocabulary where it's free, keep our guarantees (frozen
  workflow set, audience re-authorization, no-network CSP) where the
  standard leaves them to the host.
- **Inbound (we render MCP Apps):** a connection tool declaring
  `_meta.ui.resourceUri` gets an "app view" chip on the chat; clicking
  opens an `mcpapp` tab rendering the `ui://` template in an
  AppMount-grade iframe. The host bridge implements the dialect's core
  (`ui/initialize`, `tools/call`, `ui/open-link`, tool-input/result
  seeds); view-initiated calls route over the DESKTOP's own client
  connection, scoped to the view's server — an embedded app can never
  reach another connection's tools. Tool results now ride events
  (`toolUseId`/`toolResult`, cumulative per call id) so the view gets
  the data the model saw.
- **Outbound (MCP hosts render our apps):**
  `/api/projects/:id/apps-mcp` is a stateless MCP endpoint exposing one
  tool per app-callable workflow (executed under the owning app's
  audience identity — the frozen-set authorization applies to Claude
  and ChatGPT exactly as to our iframe) plus the app bundle as a
  standard `ui://` resource. The `@catamorphic/app` guest runtime is
  dual-dialect: it probes with `ui/initialize` at boot; a Catamorphic
  host ignores the probe and nothing changes, an MCP Apps host answers
  and the same bundle speaks `tools/call` — apps run in Claude/ChatGPT
  unchanged. `allowed_network_origins` finally reaches the iframe CSP
  (both mounts), closing ADR 0037's gap.
- **Agents finish apps by SHOWING them.** `build_app` compiles in the
  dev sandbox and publishes (publish is the default — "built you a
  dashboard" must end with something the user can open); apps being
  edited surface as chips on the chat (derived from file_edit paths
  under `apps/<name>/`).
- **`open_surface` opens things BEHIND the chat.** Anything tab-shaped
  (tab keys, `app:<name>`, `file:<path>`, URLs): the tab activates and
  the agent's chat steps down from full tab to its floating dock — the
  agent is showing, not replacing the user's view with itself.
- **`point_at` is the agent's finger.** Any element with
  `data-point-key` (workspace tabs by key, sidebar items, app rows) can
  be pointed at: a soft accent ring + scroll-into-view + optional short
  note. The glow is a WAITING state — the same sanctioned-loop logic as
  the question badge's pulse: it breathes until the user interacts with
  the element or the agent points elsewhere (`keep_previous` stacks a
  tour; `clear_pointers` ends it). Dismissal-by-interaction keeps the
  user in charge of their own attention.

### 2026-08-09 — Elicitation (with MRTR), and connector icons
- **Connectors can ask the user, mid-call.** MCP `elicitation/create` —
  a form, or a URL to open (OAuth and other credential handoffs) — is now
  rendered by the host. `@catamorphic/mcp` declares the elicitation
  capability (form + url) only when a handler is provided and registers
  it via `setRequestHandler`; on the stateless 2026-07-28 era the SAME
  handler auto-fulfils MRTR `input_required` rounds, so one registration
  covers both eras (that IS the MRTR implementation — no separate code).
- **One handler, routed to the front window.** The handler threads from
  where connections actually connect — the ai-sdk harness (labeled with
  the agent) and the MCP-apps client pool — down to a new
  `WorkspaceBridge.elicit`, broadcast over the existing renderer RPC.
  Only the focused window renders it (others answer null = "not me"), so
  the user sees exactly one modal; the RPC gets a long timeout (5 min)
  because a human is filling a form or doing OAuth. No window, or a
  closed modal, resolves to `decline` — a paused tool call must never
  hang forever.
- **Form vs URL, per the spec's security line.** Form mode renders the
  restricted JSON-Schema fields (string/number/bool/enum, single and
  multi-select) as a real form and never carries secrets; URL mode shows
  the full https URL and opens it as a browser tab only on explicit
  consent (never pre-fetched). The parse from JSON Schema → fields is the
  risky part and is unit-tested; the wiring is a few typechecked lines.
- **Connectors wear their icons.** MCP icons metadata (2025-11-25):
  registry `server.json` icons flow into search results and onto the
  installed connection; the Settings Connectors list shows each server's
  icon (a neutral plug glyph otherwise). Only https/data srcs are ever
  used — validated at the seam per the spec's icon security rules
  (no javascript:/file:/credentialed fetches).
- **Scope, deliberately:** roots, sampling, and `logging/setLevel` stay
  unimplemented — the 2026-07-28 spec deprecated them and says new hosts
  should not add them. Tasks, CIMD/enterprise auth, `subscriptions/listen`,
  and MCP prompts remain future work.

### 2026-08-09 — App builds see the agent's work; app tabs show the dev channel; connectors get a front door
- **Builds compile what the agent actually has.** `build_app` previously
  snapshotted the host dev tree, but a sandboxed agent's edits only land
  there at end-of-turn sync — so mid-turn builds kept failing on files the
  agent had just written ("app-api.ts is missing", forever). The sync-back
  is now a shared primitive (`sandbox-sync.ts`, exposed as
  `DevSandboxService.syncBack`): preview builds pull in-flight sandbox
  changes into the dev tree first, and publish builds go through
  `AppsService.commitDevTree` (sync → commit → pinned sha) — which also
  fixes desktop publishing outright, since the wiring never passed a
  `commitSha` and every `publish: true` build died on the guard.
- **The desktop's app tab is the owner's view: it shows the dev channel.**
  `viewState` gained `channel: "published" | "dev"` — "dev" serves the
  newest ready build of any kind. External surfaces (the apps MCP server,
  default mounts) still see only the active published version; the audience
  gate lets a builder run their own not-yet-active version because they
  already hold full identity and the headers only narrow. Clicking an app
  chip now opens the version being developed instead of claiming "no
  published version" while the agent iterates on previews.
- **Connectors have one front door.** A `ConnectorsModal` (palette:
  "Manage connectors…", keyworded `mcp`; Settings: a doorway button)
  replaces the inline Settings section: installed connections + plugin
  connectors, and a debounced as-you-type search over both ecosystems.
  Results rank official publications first — DNS-verified registry
  namespaces (not `io.github.*`) and Anthropic marketplaces — because the
  registry API exposes no install counts to sort by; each row links out to
  its repository page in a browser tab.
- **Composer media is now a button, not a secret.** Attachments were
  paste/drag-only, advertised solely by placeholder text; a paperclip in
  the composer (shown whenever the agent accepts media) opens a file
  picker filtered to the accepted kinds.
- **The agent-control pill exits like it enters.** `fade-out` mirrors
  `fade-in` (200ms, standard easing, holds the last frame); the overlay
  stays mounted through the tween and unmounts on `animationend`, per the
  motion contract's animate-before-unmount rule — both when the user takes
  control and when the agent releases it.
- **The app iframe shims `process`.** Vite lib-mode builds keep raw
  `process.env.NODE_ENV` (lib mode never injects the define), so any
  agent-authored config missing the explicit define produced a bundle that
  threw "process is not defined" before mounting — an empty tinted shell,
  for every app built that way. The guest document now defines
  `process = {env:{NODE_ENV:"production"}}` before the bundle (existing
  bundles render, React takes prod paths), and the building-apps skill
  tells agents the define is mandatory so new builds ship prod React
  outright.
- **The app iframe sizes itself.** `reportHeight()` is opt-in and almost no
  app calls it, so mounts sat at MIN_HEIGHT (240px) with the content cut
  off — a dark-themed app read as a black tab. The guest document now
  injects a ResizeObserver that posts the same `resize` message the client
  library would (`documentElement.scrollHeight`, host-clamped to
  [240, 2000]); scrollHeight is max(content, viewport), so the loop
  ratchets to the content height and settles.
- **Apps inherit the shell's design system.** The token vocabulary lives
  once in `@catamorphic/app` (`theme.ts`: color token list, `appThemeCss`,
  the shared base layer with font stacks / radii / the one easing);
  `AppMount` injects the host's resolved theme as `--color-*` vars before
  the app's own CSS and pushes changes live over a `theme` message (the
  srcdoc is never rebuilt — guests keep their state across theme
  switches). The desktop passes its profile theme from `useTheme`, and the
  building-apps skill derives its token list from the same constant and
  tells agents the rules: style through the vars, never hardcode a
  palette, surfaces = bg-raised + border + radius-lg, motion =
  ease-standard at 100–300ms. Base body styles are var-driven with dark
  fallbacks, so an unthemed host still renders sensibly; an app's own CSS
  loads last and may override anything.
  `default-agent`'s keywords (the scorer needs the query as an in-order
  subsequence, and nothing switch-y existed without a focused chat), and
  with a chat focused the chat-scoped trio (switch-agent, switch-model,
  change-effort) leads the action list — score ties resolve by list order,
  so the per-chat command wins over the profile default.
- **Guest documents are served, never `srcdoc`.** A `srcdoc`/`blob:`/`data:`
  document inherits the embedding page's Content-Security-Policy, and the
  shell's strict `script-src` (no `unsafe-inline`) silently blocked every
  app bundle and MCP view — a permanently blank iframe at MIN_HEIGHT.
  App mounts now navigate to a guest URL served by the API
  (`/apps/:name/guest`, builder shared in `@catamorphic/app`), and MCP
  views to the embedded server's `/desktop/mcp-app-view`; each response
  carries its own default-deny CSP as a header, so guests keep the exact
  isolation they had (sandbox without `allow-same-origin` → opaque origin)
  while the shell's CSP stays strict. The mount-time theme rides the guest
  URL as validated JSON so the first paint is already in the host's
  colors; later switches stay postMessage. The shell's CSP gains only
  `frame-src` for the loopback servers.
- **The live activity line stays calm; the event log carries the detail.**
  While the agent works, the chat never shows file paths, raw command
  lines, or tool names — "Editing files...", a friendly verb for
  well-known programs (`sleep` → "Waiting...", `find`/`grep` → "Searching
  files...", package managers → "Running scripts..."), and otherwise just
  "Working...". The full record moved to an expandable per-reply event
  log: each assistant message with turn events renders a muted "N steps"
  toggle (collapsed by default), and each step row — `$ command`,
  `Edited path`, tool name with the connector's icon for MCP tools —
  stays collapsed too, expanding to the tool's input/result (capped, in a
  scrollable pre). Two levels of collapse are deliberate: most readers
  never look, and tool payloads are long and technical even when the list
  itself is interesting.
- **No touched-files chips on replies.** The end-of-turn green file chips
  duplicated what the app chip and the coming git-changes tree view do
  better, and most users never clicked them; `metadata.changedFiles` is
  still persisted per message for that tree view (TODO.md). The
  jump-to-previous-message arrow also hides until the conversation
  actually outgrows the viewport — a fully visible chat needs no scroll
  affordance.

### 2026-08-11 — Desktop trigger kinds: chat and terminal as workflow events
- The desktop is now a real embedder of the new custom-trigger system: it
  registers `chat.turn-completed` (fired when an agent turn settles, with
  per-workflow `statuses` config deciding which settled states matter) and
  `terminal.idle` (fired when a project terminal returns to its prompt).
  Any project workflow can subscribe with
  `triggers: [trigger("chat.turn-completed", { statuses: ["completed"] })]`.
- Firing is always fire-and-forget from the event source: a trigger failure
  logs a warning and never breaks a chat turn or the terminal poll loop.
  Both kinds fire async — desktop workflows run on the embedded worker; no
  user-visible latency is added to chat or terminal interactions.
- The generated `catamorphic-triggers.d.ts` is synced into every project at
  boot and refreshed after each agent turn, so the coding agent always sees
  the desktop's kinds as real types. The workflow graph's entry node shows
  a badge per subscription (kind label, icon, accent color from the kind's
  display metadata), and the detail panel lists each binding with its
  config — subscriptions are visible where the workflow is read, not
  hidden in host state.

### 2026-08-12 — Workflows as AI tools: `ai.tool-call` and the per-project MCP server
- The desktop registers `ai.tool-call` (ADR 0042), the first parameterized
  kind: its payload is one typed hole, so a workflow's own input type IS
  the tool's argument schema. Opting a workflow into tool-hood is one line
  of workflow code — `triggers: [trigger("ai.tool-call", { description })]`
  — with the schema derived from code and frozen at deploy, never written
  by hand. A hole that would freeze to `any` fails the deploy, not the
  model's tool call.
- Every chat session now mounts its project's workflow-tools MCP endpoint
  (`/api/projects/<id>/mcp`) as the `catamorphic` server, via the new
  session-scoped `mcpServersForSession` hook on the Claude Code and ai-sdk
  harnesses. Agents see `mcp__catamorphic__<tool>` beside their connector
  tools — same namespacing, same event pipeline, no special-casing in chat.
  Claude Code re-resolves the server every turn, the built-in agent
  connects fresh per session (never caching a failed connect) — so a tool
  workflow the agent just wrote is callable on the next turn or next chat,
  and a transient endpoint hiccup never poisons future sessions.
- Tool calls run sync-until-first-wait: settled output returns inline;
  a workflow that needs to wait detaches and hands back a run id for the
  shared `catamorphic_poll_run` tool. `canSuspend: false` bindings are
  guaranteed inline answers — the tool contract mirrors the run model
  instead of pretending every tool is instantaneous.
