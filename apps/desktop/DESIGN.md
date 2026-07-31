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
6. **No decorative motion.** Transitions are 120–180ms with `--ease-standard`,
   and only on state changes (hover, expand, enter). Nothing loops or bounces.

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

## Shape & spacing

- Radii: `--radius-sm` 4px (inputs, chips), `--radius-md` 6px (buttons, list
  rows), `--radius-lg` 10px (panels, dialogs).
- Spacing on a 4px grid. Common paddings: 8 (compact), 12 (row), 16 (panel).
- Sidebar rows are 28px tall; sidebar width 260px; right panel 380px.
- Borders over shadows: `1px solid var(--color-border)`.

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

- New colors enter as a semantic token pair (dark + light) in `styles.css`,
  documented here, then used via Tailwind (`bg-bg-raised`, `text-fg-muted`, …).
- Light theme flips by setting `data-theme="light"` on `<html>`.
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
