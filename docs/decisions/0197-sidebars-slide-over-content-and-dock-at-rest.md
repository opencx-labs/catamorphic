# 0197 — Sidebars slide over the content and dock at rest

- **Status:** Accepted
- **Date:** 2026-10-02

## Context

Opening or closing a desktop sidebar animated its width, so the content
beside it changed size on every frame. A web page renders in its own
process and the window waits for it on each resize; a terminal refits and
Monaco relays out. With a GitHub tab showing, a toggle ran several frames
of 40–67 ms.

The first fix (2026-09-26) held heavy content (pages, terminals, the
editor, app frames) at one width through the transition, pinned to the
content's left edge, and resized it once at the end. That removed most of
the stutter but made the page itself move: opening dragged the whole page
right with the sidebar's edge and then snapped centered content back by
half the sidebar's width when it resized; closing reflowed the page on the
first frame (one stalled frame of 50–67 ms at the start of the motion) and
then slid it left. The hold also ran script on every toggle (a long
animation frame of 56–90 ms) and needed a wrapper and a hook in every
screen with expensive content.

## Decision

**A sidebar slides over the content and takes its place only once it has
stopped.** The `<aside>` holds the sidebar's place in the row (its width
once docked, zero otherwise); the panel inside it is absolutely placed and
slides with a CSS `transform`. `lib/sidebar-motion.ts` sequences it:

- Opening: the panel slides in over the content, then docks. The content
  resizes once, with nothing moving.
- Closing: the sidebar undocks first, so the content takes the space
  beneath the still panel and gets two frames to paint at its new size,
  then the panel slides away and reveals it.
- An overlay sidebar (the compact window's hover reveal) slides the same
  way and never docks.

The phase follows the panel's own transform transition (`getAnimations`),
so an interrupted toggle reverses from where it is, reduced motion's
near-instant transition ends on the next frame, and a slide that is
cancelled or never starts (a panel that is not rendered) ends at once.
The sidebar's own toggle and the chrome that makes room for it (the tab
strip's offset) follow the phase, not the saved setting, so they move with
the panel. The workspace row clips rather than hides its overflow: a
closed right panel waits past the window's edge and must not make the app
scrollable.

`lib/layout-transition.ts` and `data-layout-transition` are removed, and
screens no longer wrap heavy content.

Alternatives considered:

- **Keep the hold, anchored to the edge that does not move** (or shifted by
  half the slide so centered content lands without a jump). Cheaper to
  change, but closing still stalled on its first frame and every screen
  kept the hook.
- **Cross-fade a snapshot of the page over its one reflow.** Reading a
  page's frame back from the GPU takes tens of milliseconds before the
  motion could start, which delays every toggle.
- **Push the content with a transform** (resize it once at the start and
  slide it with the sidebar). Closing works, but opening leaves an empty
  strip at the far edge that closes as the content slides.

## Consequences

- The motion is a compositor transform: it stays smooth whatever the page,
  the terminal or the renderer's main thread are doing. Measured on a
  GitHub tab: no long animation frames; the one frame that waits for the
  page (33–50 ms) falls while nothing moves. A terminal toggle has no long
  frames at all.
- Content, including ordinary DOM such as a chat, reflows once per toggle
  instead of gliding with the sidebar. Closing starts two frames later than
  before so that reflow happens under the panel.
- The sidebar covers the content's edge for 200 ms while it slides. The
  docked sidebar draws no shadow, so the slide shows none either; the
  compact overlay keeps its shadow and corner.
- The content frame's padding and corner preview (Settings) still animates
  the workspace margins, so a page visible beside Settings resizes on each
  frame of that 200 ms preview. The removed hold covered it; it is rare
  enough not to justify a second mechanism.
- Anything new that animates layout beside heavy content (a split's
  divider, a future panel) should follow the same pattern rather than
  animating a size.
