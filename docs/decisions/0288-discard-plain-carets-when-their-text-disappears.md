# 0288 — Discard plain carets when their text disappears

- **Status:** Accepted
- **Date:** 2026-10-28

## Context

When selected plain text is removed, Chromium can relocate its collapsed
selection to the surrounding element. A boundary before a long hidden chat
can make the renderer search the hidden text for a usable caret on every
frame. A controlled Chromium fixture reproduced this native cost. Keeping
the boundary also keeps an anchor for the person's next Shift-click.

## Decision

Discard a collapsed, non-editor selection when the ordinary text holding
it disappears. Tabaza approved discarding this invisible caret, accepting
that the next Shift-click starts a fresh selection.

Extend the existing document selection guard. Track the plain caret's raw
node, because live ranges adjust their boundaries during removal. Clear
only the browser-adjusted boundary attributable to that removal, or a text
node that became empty. Preserve editor carets, highlighted selections,
content that merely moved, and selections subsequently made elsewhere.
The existing release and restoration rules for inert content remain.

## Consequences

Deleted plain content leaves no document caret for Chromium to resolve.
The next Shift-click has no anchor from that deleted content. This is a
deliberate interaction choice, not a general rule clearing every
noneditable caret. The guard observes removals and text changes without
layout reads; native tests cover removal, preservation, and restoration.
