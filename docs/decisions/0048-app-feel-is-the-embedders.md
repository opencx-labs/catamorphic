# 0048 — An app's feel is entirely the embedder's

- **Status:** Accepted
- **Date:** 2026-08-14
- **Builds on:** 0037 (app guest runtime and mount), 0045 (desktop as dev shell)

## Context

The app UI kit (`@catamorphic/app/ui`, app package 0.0.2) shipped with the
desktop shell's aesthetics baked into its stylesheet: Inter-first font
stacks, 13px base type, 28px rows, 150/220/180ms motion. Colors were
already host-injected (0037), but everything else an app *felt* like was
the desktop's — any other embedder mounting an app got a small copy of
Catamorphic Desktop inside its own product. That is backwards for a kit
meant to make apps look native to **whatever host mounts them**.

## Decision

**The framework's app kit ships structure and behavior — focus traps,
aria wiring, data-state patterns, the calendar logic. Every aesthetic
decision flows from host-supplied theme tokens with neutral defaults. The
desktop app passes its own values as just one embedder.**

### The token contract

`AppHostTheme` grows optional feel tokens beside `appearance` + `colors`:

| Field | CSS vars | Covers |
|---|---|---|
| `fonts.sans/mono` | `--font-sans`, `--font-mono` | font stacks |
| `radii.sm/md/lg` | `--radius-sm/md/lg` | corner radii |
| `easing` | `--ease-standard` | the host's one curve |
| `baseFontSize` | `--cat-font-size` | base type size |
| `rowHeight` | `--cat-row-h` | list/table/control density |
| `motion.fast/base/slow` | `--cat-motion-fast/base/slow` | hover feedback / structural enters / large surfaces |

`appThemeCss` emits every provided token; the guest runtime's live-theme
handler applies the same set over postMessage, so feel switches without a
reload just like color always has. The fastify guest route validates each
field with the same character-exclusion rules as colors (no `<>{};`,
length caps) and drops an invalid field or color entry — never the whole
theme.

### Neutral defaults, kit consumes only vars

`APP_BASE_CSS` defaults are genuinely neutral: `system-ui` sans,
`ui-monospace` mono (no Inter/JetBrains preference), radii 4/6/10,
13px/11px type (`--cat-font-size` / `--cat-font-size-sm`), 28px rows,
150/220/250ms motion. The kit stylesheet contains **no** typographic,
motion, density, or radius literal: every such value is a var or a `calc`
derived from one (e.g. small buttons are `calc(var(--cat-row-h) - 4px)`,
dialog exits ~82% of the enter duration). Remaining px literals are
structural — 1px hairlines, glyph geometry, the 4px spacing grid, fixed
calendar/overlay geometry — and the spinner/shimmer loop rates stay
constant on purpose: they signal "activity", not the host's pacing.

### Embedder total-control hooks

`buildAppGuestDocument` gains `hostCss` — an embedder stylesheet injected
after the kit CSS and before the app's own CSS, so a host can restyle or
extend `cat-*` wholesale — and `kit: false` to omit the kit stylesheet
entirely. Style order is override order: neutral base, host theme, kit,
host CSS, app CSS.

### The desktop is just one embedder

The desktop assembles its mount theme in one place
(`appHostTheme` in `renderer/lib/theme.tsx`): the profile's resolved
colors plus the shell's feel constants (Inter/JetBrains stacks, 13px,
28px, radii 4/6/10, `cubic-bezier(0.2,0,0,1)`, 150/220/250ms). Desktop
rendering is pixel-identical to before; the values just arrive as theme
tokens instead of living in the kit.

## Consequences

- An embedder with a serif 15px/36px-row/2px-radius look mounts the same
  app bundle and gets its own product's feel, verified visually both ways
  (desktop-token render matches the pre-change screenshot bit-for-bit in
  layout; a deliberately alien theme visibly changes font, size, density,
  radii, and motion).
- The building-apps skill speaks host-neutrally: apps follow "the host
  application's theme"; hardcoding a value a token covers is a defect.
- App package 0.0.3; hosts on 0.0.2 keep working — every new field and
  flag is optional with unchanged defaults (kit injected, no host CSS).
