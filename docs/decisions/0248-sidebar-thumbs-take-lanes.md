# 0248 — Sidebar thumbs take lanes, hidden at rest

- **Status:** Accepted (amends 0237)
- **Date:** 2026-10-18

## Context

ADR 0237 took every scrollbar out of the sidebar: lists fade the edge they
continue past, and a section that asks (`scrollbar: true`) gets one thin
thumb on the sidebar's outer edge. The sidebar's own panel had no thumb at
all, so a person had nothing to drag and no sense of how far a long
sidebar goes. Giving it one on that same edge would put it exactly where a
section's thumb shows: two thumbs over each other, the overlap the
person asked never to see.

## Decision

**Nested lists, nested lanes.** Overlay thumbs stand for the sidebar's
lists in lanes from its outer edge in (`OverlayScrollbar`, `lane`):

- `panel`: the sidebar's own panel, on the outer edge, in the panel's
  padding. Every sidebar has it.
- `section`: a section's list that asks for a thumb, one lane in. A
  sidebar with such a section widens its panel's outer padding from 8px
  to 16px to hold it: 2px past the panel's thumb and 3px before the rows,
  so no thumb ever lies over a row or its buttons. Only such a sidebar
  mounts it.

Both are hidden at rest. A thumb fades in while its list scrolls, or while
the pointer is within 16px of the outer edge beside it (both can show,
side by side), can be dragged, and fades out 900ms after. A section's
track follows its list when the panel under it scrolls. The panel's thumb
takes no room; rows sit as before unless a section asks for its lane.

Every other section keeps no thumb and fades its edges, as ADR 0237 set; a
note section's own scroller now fades too. App sections are guest
documents and scroll as their app chooses.

Considered: one thumb that stands for whichever list moved last (ADR
0237's for sections), which cannot show the panel and a section at once
without the overlap; a section's thumb over its rows' leading padding,
which caught clicks meant for a row's start (and its ⋯ on a right
sidebar); a section's thumb on the sidebar's inner edge, under the resize
handle; native scrollbars, which reserve a column and cannot be hidden at
rest on every platform.

## Consequences

A long sidebar shows where it is while it scrolls. `scrollbar: true` moves
its thumb a lane in from where it was and costs its sidebar 8px of width
on the outer edge.
