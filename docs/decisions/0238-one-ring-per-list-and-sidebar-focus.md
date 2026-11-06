# 0238 — One ring per list; an opened sidebar focuses what is in front

- **Status:** Accepted (amends 0168)
- **Date:** 2026-10-17

## Context

Opening a sidebar left focus where it was, so reaching what was in front by
keyboard meant tabbing through the panel's headers, and the arrows stopped
at each list's end. Each tree row drew its own ring (0168's inset ring, -1px)
around a box that began at the list's edge while the row's content was
indented by a margin: a child's ring took in its indent, the highlight did
not, and a highlighted row's background covered its own ring. The person
asked that an opened sidebar focus the row of what is in front, that the
arrows navigate from there, and that the rings never cross between items and
move well.

## Decision

- **One ring per list.** The kit `Tree` places each row at its depth
  (`indent`), so a row's box is where its content starts, and draws one ring
  (`[data-tree-focus]`) over the focused row's box, above every row. Rows
  touch, so the ring sits wholly inside the row (offset by its full width,
  `calc(-1 * var(--focus-ring-width))`), not 0168's -1px inset, which would
  reach a pixel into the neighbour. It glides 150 ms between rows and rides
  its row's own slide when rows move under it.
- **Focus a host asks for.** `focusTreeRow({ scroller, which, visible })`
  reveals a list's first, last or selected row and, when drawn, focuses it
  within the call, so a host can count the move as the app's own
  (`moveFocusAsApp`), which opens no row preview. `visible` uses
  `FocusOptions.focusVisible`, which this Chromium now honors (0168 recorded
  that it did not).
- **Arrows past an end.** A tree keeps its arrows at both ends, so nothing
  around it scrolls, and tells a host listening through `onTreeLeave` when
  nothing is left to load there; the desktop sidebar goes on into the next
  or previous open list in its panel.
- **An opened sidebar focuses what is in front.** Opening a sidebar (its
  shortcut or toggle) focuses the selected row of a list in its shown panel,
  waiting a moment for lists still loading, and gives up once the person
  has moved focus somewhere (`personMovedOn`). A shortcut that moves focus
  counts as the keyboard (`keyMovedFocus`), amending 0168's rule that
  shortcuts keep the input that led: opened by a key, the ring shows; by a
  press, it waits for the first arrow.

Rejected: a ring on each row (it can only be inside its own row's stacking
order, under a raised neighbour or its own highlight); leaving end arrows
unhandled for hosts to catch (a tree without a host would scroll its page);
window-wide listeners to cancel the opening focus (the app already counts
the person's input once, `lib/app-focus.ts`).

## Consequences

- Hosts of the kit tree get the ring, the indent and the hand-off without
  styling rows; a row component no longer indents itself.
- A row the tree has not loaded (inside a folder never opened) does not take
  the opening focus; sources that can place what is in front (`reveal`) do.
- Focus the tree held follows its roving row when that row goes; focus a
  person put elsewhere stays there.
