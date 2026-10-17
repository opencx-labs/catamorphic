# 0237 — Lists fade where they continue

- **Status:** Accepted
- **Date:** 2026-10-17

## Context

Work's sidebar showed where its lists were scrolled with a thumb on the
window's edge for every list, while their content was cut hard at their
edges; a chat's conversation was cut at the composer's border, and the
palette's results at the panel's. The person asked for overflow hints
(content fading near an edge it continues past) as the one way Work shows
that a list goes on, with a scrollbar something a sidebar section chooses.

The app kit already fades edges for guest apps (`ScrollHint`): gradient
overlays that must be told the color of the surface behind them, which a
translucent sidebar or a themed chat does not have.

## Decision

One overflow hint for Work's own surfaces, in two parts:

- `cat-edge-fade` (`@catamorphic/ui/styles.css`) masks a scroller's content
  over the last `--cat-edge-fade` (24px) of its top and bottom, by two
  lengths: how far the content goes on past each edge, up to the fade's.
  A mask needs nothing from the surface behind. Its scroll padding keeps
  what focus or `scrollIntoView` brings into view clear of the fade, except
  in a list that holds its end still by scroll anchoring (the chat), since
  the browser anchors only inside the scroll padding.
- `fadeEdges(scroller)`, the registry item `edge-fade` (installed beside
  `chat-timeline`, ADR 0218), keeps those lengths from a scroll, the
  scroller's own size, and a marker laid over the content's last stretch
  that an intersection observer reads pixel by pixel. It costs nothing at
  rest.

The sidebar panel, every section's list (the kit tree's `onViewport`), the
chat's conversation and the palette's results use it. Sidebar lists keep no
scrollbar; a section asks for the thumb with `scrollbar: true`, and none of
Work's default sections does. Lists outside the sidebar keep their native
scrollbars.

Rejected:

- CSS scroll-driven animations would have needed no script, but their
  animations count as running for as long as a list is shown: what waits
  for motion to end (`getAnimations()`, the detached dock's click-through
  shape, many end-to-end waits) would wait forever.
- Observing the content's size puts a box above the content's own resize
  observers into every resize pass; a collapsible that writes its height
  from its observer (a sidebar section) then makes Chromium report an
  undelivered-notification loop.
- `ScrollHint`'s overlays need the surface's color.

## Consequences

- A faded scroller lays its content out as blocks (the marker follows it),
  and its own size changes only outside resize observer callbacks. A jump
  by `scrollTo` leaves `edgeFadeLength(scroller)` clear itself.
- Without observers (a test DOM, a server) `fadeEdges` does nothing and the
  edges stay sharp.
- The kit's `ScrollHint` remains the guest apps' variant. Moving it onto the
  same mask would drop its `fadeColor`; that is follow-up work.
