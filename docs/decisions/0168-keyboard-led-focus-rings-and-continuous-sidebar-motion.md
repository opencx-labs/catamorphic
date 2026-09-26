# 0168 — Keyboard-led focus rings and continuous sidebar motion

- **Status:** Accepted
- **Date:** 2026-09-26

## Context

Focus rings drifted into many private recipes: 1px and 2px rings, offsets of
-2px, 1px, 2px and 4px, and per-component `focus-visible:outline` utilities.
Rows with Tailwind's `transition-colors` faded their ring in from the text
color, so a white ring flashed before the accent. Chromium also turns
`:focus-visible` on for whatever holds focus after any key press: pressing
Escape to cancel a right-click menu lit the row focus returned to.

The sidebar framework snapped where it should move. The pinned area mounted
and unmounted in one frame, on unpin and on every drag in the window.
Sections hidden when empty jumped out of the layout. `Collapsible` animated
only its own toggle, so skeleton rows becoming rows snapped. A removed tree row
faded, left a hole, then the rows below slid, about 450 ms in two phases. A
dropped row glided in from its origin after the host's reply.

## Decision

**One ring, led by the keyboard.** Every focus ring is
`outline: var(--focus-ring-width) var(--focus-ring-style) var(--color-accent)`,
outside a standalone control (`--focus-ring-offset`, 1px) or inside a row,
tile or anything stacked or clipped (`--focus-ring-inset`, -1px, via
`.focus-ring-inset` or the sidebar and tree rules). Every element rests with
the accent as its outline color, so no transition can fade a ring in. The
renderer marks `data-focus-modality` on the root: `pointer` after a pointer
press and `keyboard` after Tab, arrows, Home/End, PageUp/PageDown, F6 or the
context-menu key. While the pointer leads, the ring style is `none`. Escape,
Enter, typing and shortcuts keep the input that led. Row previews open on
focus only when the keyboard leads. Design lint rejects private ring
utilities and literal outline rings.

Rejected: `FocusOptions.focusVisible` (not honored by this Chromium), and
blurring focus after pointer-opened menus (loses the keyboard position).

**The sidebar moves continuously.** `Collapsible` measures its content and
tweens to its height whenever it changes, not only on open and close. It
follows exactly, without its own tween, while a descendant animates its
height or while changes arrive continuously (a resize drag), so nested motion
never chases. Hidden-when-empty sections collapse before they hide and open
from nothing when they fill. The pinned area opens through the same
primitive, only for drags it can accept, and stays open until a pin dropped
into it arrives.

The public `Tree` removes a row from its layout at once, so the rows below
slide while the row fades where it stood. The dragged row dims. On a drop
within the tree it stays dimmed until the host's reorder lands, then fades
into its new slot while its neighbours slide. The insertion line glides
between slots and stays inside the viewport. `TreeDragAndDrop` gains
`onDragStart` and `onDragEnd`, and vertical workspace tabs use the shared
model instead of their own. Rejected: optimistic local reordering inside
`Tree` (hosts differ in move semantics, and a correction jump is worse than
a short dim).

**Apps built by agents share both.** The guest base sheet carries the ring
tokens, the accent resting outline color and the pointer-led rule; the inline
guest runtime tracks keyboard versus pointer like the shell; the kit draws
its rings from the tokens (a zero-specificity `:where(:focus-visible)` rule
covers controls an app writes itself), its checkbox is the shell's, and its
select uses the shell's `base-select` picker where the engine supports it.
`Collapsible` is one measured-height primitive in `@catamorphic/app/ui`,
which the shell re-exports, and `Tree` takes its timing from
`--cat-motion-base`. The `designing-apps` doctrine says so.

## Consequences

- Keyboard users see the same ring everywhere, the moment it appears. Pointer
  users no longer see rings after Escape or Enter.
- New components get the ring for free; a private recipe fails design lint.
- Any sidebar content change animates its height. A host that needs an
  instant change inside a `Collapsible` gets it only during continuous
  changes or nested height motion.
- `Tree` hosts rendering exiting rows receive their last placement, not a
  live index. Rows that were never rendered leave without a fade.
