# 0299 — Expanded steps share the timeline window

- **Status:** Accepted
- **Date:** 2026-11-01

## Context

Profiling a fixed 3,098-step history found that expanded headers retained tens of
thousands of elements and produced long mount tasks. Folded history already
releases rows after its exit. Expanded history needs bounded automatic mounting
without changing the timeline's scroll surface or disclosure motion.

## Decision

Window long expanded step lists inside the existing timeline scroller. Render
nearby headers with overscan and replace distant closed ranges with measured
space. Retain keyed row siblings and disclosure choices above the window. Keep
explicitly opened details and rows involved in focus, selection or pointer input
mounted. Materialize the next logical control when native Tab crosses a skipped
range, and mount a notification's focused target before message lookup.

Keep the mounted subset through the existing closing transition. A row returning
from outside the window is historical content and does not play an entrance.
Viewport, focus and selection are cached browser-state snapshots, published
synchronously without deferring another frame. Overscan retains at least 1,600 pixels or two
viewports on each side for asynchronous compositor scrolling; arbitrary jumps
can exceed any finite buffer. One persistent resize observer supplies row
measurements in layout units. Small groups do not subscribe to global
interaction events.

The shared sidebar Tree owns a fixed-height scroller and roving focus, so it does
not model this variable-height document log. Nested scrolling and a separate
pagination interaction would change the existing reading behavior.

## Consequences

Automatic header mounting follows viewport size rather than history length.
Explicitly opened payloads are an intentional exception so inner scrolling and
selected content survive. Height estimates for unseen closed headers are corrected
by measured rows through the existing scroll anchoring. Browser find and assistive
technology see mounted content; ordinary keyboard traversal still reaches every
step. Session data and protocol behavior are unchanged.
