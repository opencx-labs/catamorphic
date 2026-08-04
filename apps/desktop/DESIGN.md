# Catamorphic Desktop — Design System

The desktop app aims for the OpenCode / Obsidian feel: minimal chrome, dark-first,
terminal-editor calm. Everything visual flows from the tokens in
[`src/renderer/styles.css`](src/renderer/styles.css).

**North star: this is a really high-quality product meant for daily use.
Every user interaction matters and should be polished.** When in doubt,
spend the extra effort on the transition, the empty state, the keyboard
path, the edge case. Test every UI change visually, end to end, before
calling it done.

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
| `fade-in` (modal section swap) | 200ms | height tween |
| `profile-veil-in` / `profile-veil-out` (in-place profile switch) | 200ms | each other (exact mirror) |
| `question-in` (ask_user panel) | 260ms | — |
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
- **There is no way to become a "legitimate browser" in Google's eyes.**
  No registration, no allowlist, no vendor UA program — the
  supported-browser gate is pure sniffing. Vivaldi (same engine,
  millions of users) proved the targeting was by *name*: misspelling
  their token "Vivaldo" made Google properties work again, so in 2019
  they shipped a Chrome UA by default. Edge does the same. Since the
  engine genuinely is Chrome's, presenting as Chrome is the honest,
  permanent answer — not a stopgap.
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
- Verified end to end: accounts.google.com serves the normal sign-in
  form, and a live request echo shows UA + Sec-CH-UA agreeing.
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
  `BUILTIN_ACTIONS`-derived types assume the set is closed. opencx's
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
