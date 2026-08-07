# Catamorphic Design Language

One visual language across everything Catamorphic ships: the desktop app,
the website, future docs and screenshots. Two implementations exist:

- **Desktop app**: [`apps/desktop/DESIGN.md`](../apps/desktop/DESIGN.md) is
  the detailed system (tokens, motion contract, component rules) and the
  **source of truth**. Tokens live in
  `apps/desktop/src/renderer/styles.css` + `src/main/theme.ts`.
- **Website**: `site/styles.css` mirrors the desktop tokens by hand.

**The rule: the desktop app leads, the site follows.** If a token or pattern
changes in the app, the site inherits it. Never the reverse, and never a
site-only invention. Anything new the site needs must be composed from the
existing palette and patterns.

## Identity

- **Logo**: the banana-bracket C, an open circular arc plus vertical bar, a
  nod to catamorphism's ⦇f⦈ banana brackets. Stroke `#f95225`, round caps.
  Canonical files: `site/assets/logo.svg`, `favicon.svg`.
- **Wordmark**: lowercase `catamorphic`, Inter 600.
- **Accent**: Catamorphic orange, `#f95225` on dark and `#d63c0c` on light.
  **The only accent.** If something needs to stand out beyond it, the layout
  is wrong, not the palette.

## Foundations

- **Dark-first.** Dark is the default everywhere; light is an override.
- **Surfaces** (dark anchors): bg `#0a0a0b`, raised `#101012`, overlay
  `#16161a`, inset `#060607` (code, wells, terminals).
- **Text**: fg `#e6e6e9`, muted `#9a9aa3`, faint `#5c5c66`.
- **Depth is flat**: hierarchy from surface steps and 1px borders
  (`#232329`, strong `#33333b`). Shadows only for true overlays.
- **Type**: Inter for UI and prose; JetBrains Mono for code, ids,
  timestamps, and section eyebrows. Base sizes stay small and dense.
  This is a tool's voice, even on the marketing site.
- **Radii**: 4 / 6 / 10px (inputs / buttons / panels). 4px spacing grid.
- **Status colors are low-chroma**: states inform, they don't scream.

## Motion

- One easing: `cubic-bezier(0.2, 0, 0, 1)`. Durations 100 to 300ms.
- Motion only signals state change; nothing loops or bounces except
  indeterminate progress. Exits mirror entrances and animate before
  unmount. (Full contract + enforcement: desktop DESIGN.md, `motion.e2e.ts`.)
- The site's one sanctioned pattern beyond the app's contract:
  scroll-reveal (`.reveal`, a fade/rise once per element, 12% threshold).
- Motion quality is a product differentiator, deliberately: nothing on the
  market is this smooth for daily use, and keeping it that way is part of
  the brand. Treat any dropped frame during an entrance as a bug.

## Voice

- **No em-dashes. No en-dashes. Anywhere user-facing.** They read as
  AI-generated. Use a comma, a colon, a period and a new sentence,
  parentheses, or the word "and"/"or". This applies to the app's UI
  strings, the site, README, skills, llms.txt, error messages, and any
  agent-visible prompt text. (Founder rule, 2026-08-08.)
- **Human-led, capability first, control second.** The user is the subject
  of product copy; agents are the help. "All your work, one place", never
  "agents can do real work now". Lead with what the user gets done on real
  surfaces; visibility, take-over, and diffs support the claim and must not
  headline every section. Trust is one card, not the chorus.
- **Desktop and framework relate as reference implementation.** The desktop
  app is the framework's reference implementation, a working demo of what
  embedders can build. Use that phrase; don't invent new relationship
  metaphors per page.
- **Workflows and apps are co-equal.** Framework messaging always names
  both faces: durable automations (workflows) and the frontends built on
  them (apps). Never reduce the framework to "workflow automation".
- Section eyebrows are mono `// comments` (`// the idea`, `// how it works`).
- Sentence-case headings; one idea per heading. Claims stay honest:
  features in progress say so in-line (see the desktop page's
  *"In progress."* notes).
- Empty states and footers are quiet: muted color, one line, no decoration.
- The footer signs with banana brackets and a middot:
  `⦇ catamorphic ⦈ · <one quiet line>`.

## Checklist for any new surface

1. Tokens from the palette above; no new hex values.
2. Inter + JetBrains Mono only.
3. 1px borders for structure; shadow only if it truly overlays.
4. Accent used for: primary action, active/selection, focus. Nothing else.
5. Motion within the contract; verify visually before calling it done.
6. Dark-first; check light mode if the surface supports it.
7. Zero em/en-dashes in any string a user or agent will read.
