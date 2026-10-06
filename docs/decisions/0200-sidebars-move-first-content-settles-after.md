# 0200 — Sidebars move first; the content settles after them

- **Status:** Accepted
- **Date:** 2026-10-02

## Context

Opening or closing a desktop sidebar animated its width, so the content
beside it changed size on every frame. A web page renders in its own
process, and Chromium does not draw the window until a resized page has
repainted at its new size; a terminal refits and Monaco relays out. With a
GitHub tab showing, a toggle ran several frames of 40–67 ms.

The first fix (2026-09-26) held heavy content at one width through the
transition, pinned to the content's left edge, and resized it once at the
end. The stutter was gone, but the page itself moved: opening dragged the
whole page right and then snapped centered content back when it resized;
closing reflowed the page on the first frame (a 50–67 ms stall as the
motion began) and then slid it.

Any page resize stalls the window until the page repaints (40–300 ms
depending on the page), so the content cannot change size while something
moves without stuttering. Safari's sidebar (US patent 9,761,034) shows how
to hide the change instead: a snapshot of the page moves to where the page's
main content will land, while the real page lays out behind it.

## Decision

**The sidebar moves the moment it is toggled, and the content settles after
it** (`lib/sidebar-motion.ts`).

- The panel slides with a CSS transform: over the content when opening,
  away from it when closing. The compositor runs it without layout, and
  nothing beside it changes size while it moves. The aside holds the
  sidebar's place in the row and changes only at rest.
- Once the panel is still, the content takes or gives back the space in a
  view transition (`lib/sidebar-transition.ts`). Chromium snapshots the
  content (pages included) on the GPU; the real content lays out once
  behind the snapshots; the old and new snapshots then move with the
  content's box and cross-fade over 200 ms. Inside the box they travel by
  how far the content's main column moves: measured for our own content,
  and for a page read just before the content resizes (a column centered
  between margins moves by half the change; anything else keeps its left
  edge, since a page cannot report its new layout while the transition holds
  rendering). A page that cannot answer within 100 ms counts as centered.
  Snapshots are not scaled, so text never stretches.
- Any page resize waits for the page to repaint, so that wait falls in a
  short hold between the slide and the morph, while nothing moves.
- An overlay sidebar (the compact window's reveal) only slides; the content
  never moves.
- The phase follows the panel's own transform transition
  (`getAnimations`), so an interrupted toggle reverses from where it is and
  a cancelled slide ends at once. One morph runs at a time; it always
  applies, without a transition if the panel has started moving again, and
  then leaves the content alone. The sidebar's toggles and the room the
  chrome makes for it follow the motion, not the setting. Only the visible
  workspace's sidebars morph or carry view transition names, which must be
  unique across the window.
- What slides is what was shown. A sidebar's sections stay live while the
  panel is on screen, sliding included, and pause once it has gone; pausing
  never clears what a section shows. Both sides use one toggle in every
  place it appears. (Amended 2026-10-06.)

`lib/layout-transition.ts`, `data-layout-transition` and the per-screen
width-holding wrappers are removed.

Alternatives considered:

- **Morph from the click** (one view transition sliding the sidebar and
  morphing the content together). The motion cannot start until the page
  has repainted at its new size: 80–300 ms after the click with nothing
  moving. Rejected: a toggle must respond at once.
- **Slide, then snap** (dock at rest without a morph). Responsive and
  stutter-free, but the page's one reflow reads as a jump.
- **Hide the page while it repaints** so the morph need not wait. The page
  stops painting while hidden, and showing it again stalled the window
  mid-animation (25–65 ms).
- **Read the page's new layout before animating** (Safari measures where
  its content lands). The resize reaches the page only once the view
  transition resumes rendering, about 400 ms later.

## Consequences

- Both directions respond within a frame or two of the click, and every
  moving frame is a compositor frame: no frame over 20 ms during the slide
  or the morph on a heavy GitHub page, a terminal or app content.
- A toggle lasts longer overall: 200 ms of slide, a hold while the content
  lays out (about 50 ms, up to 150 ms on the heaviest pages), and 200 ms of
  morph. The content visibly follows the sidebar.
- Edge content the main column does not carry (a right-aligned button on a
  left-aligned page) cross-fades between its two places instead of moving.
- Closing leaves the sidebar's background showing where it was until the
  content takes the space.
- The content frame's padding preview in Settings still animates the
  workspace margins, so a page visible beside Settings resizes on each
  frame of that 200 ms preview.
- Anything new that animates layout beside heavy content should move over
  it and let the content settle once, rather than animating a size.
