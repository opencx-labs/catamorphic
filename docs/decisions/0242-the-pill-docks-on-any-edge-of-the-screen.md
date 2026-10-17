# 0242 — The pill docks on any edge of the screen, the notch included

- **Status:** Accepted (amends [0121](0121-persistent-project-workspaces-and-a-shared-chat-dock.md) and [0127](0127-dock-placement-and-chat-runtime-choices.md))
- **Date:** 2026-10-17

## Context

The pill (the dock's bubble strip, with its chats, new chat, voice and
downloads) can float in a window of its own above every app (ADR 0121), but
only along the bottom edge, inside the front Work window's chat region while
Work is in front, and only through a right-click. People keep Work minimized
and want the pill where they look: at the bottom, on either side, or around
the MacBook camera notch, the way the Companion widget sits.

## Decision

**Where it lives.** On the desktop the pill docks to one edge of a display,
`dockEdge`: `bottom` (the default), `left`, `right` or `top`. The bottom keeps
its collapsed corner (`dockSide`) and open placement (`dockPlacement`).
`left` and `right` hold a vertical pill centred on the edge, its chats opening
beside it. `top` centres it on the display: around the notch on a display that
has one, as a black island that opens downward when the pointer reaches it,
and under the menu bar elsewhere; chats open below it. The bottom pill still
rests in the front Work window's chat region while Work is in front, unless
`dockFollowsWindow` is off; the other edges belong to the screen. Edge, corner,
placement and display (`dockDisplay`) are saved, never coordinates; a display
that is gone gives the main display without losing the saved one.

**Moving it.** The collapsed bubble and the arrows drag in two dimensions,
across displays: the window follows the pointer at its size, and letting go
lands on the edge of the display under the pointer nearest the point it was
thrown towards (its position 0.15 s on at the release speed), then on the
bottom corner or placement by the 40% rule. The window glides there
(critically damped; instantly with reduced motion). While it is held, a
display-wide overlay that never takes a click shows where it can land, the
nearest spot lit. Escape cancels; arrow keys move it to the spot that way.
The pill's menu ("Dock at") and Settings move it too, and the palette's
settings search finds them.

**The notch.** Its rectangle comes from `NSScreen.auxiliaryTopLeftArea` and
`auxiliaryTopRightArea`, read through JavaScript for Automation (no native
build), keyed by `NSScreenNumber`, which is Electron's display id. Without
them an internal display whose menu bar is at least 30 points tall counts as
notched (a centred 185-point cutout). A full-screen Space reports no safe area,
so the last real cutout is kept. At the notch the window sits over the menu bar
(`status` level, `enableLargerThanScreen`) and restores its frame whenever
macOS pushes a frameless window below the menu bar.

**Settings.** A Pill section shows where the pill lives on miniature screens
(in Work, or on the desktop at an edge, the notch on a Mac) and holds
following the window, opening at the notch on hover, the corner and
placement, and chats from every project.

Considered: Companion's single click-through window covering each display,
with every motion in the page. It moves best, but a display-sized window that
fails to let a click through locks that display (Companion, 2026-10-12), and
Wayland can neither pass clicks through nor shape a window. The pill keeps
its window sized to what it draws; only the drag overlay covers the display,
and it never takes input.

## Consequences

The pill stays on screen however Work's windows are minimized, closed or
covered, wherever the person put it. The window still resizes as chats open,
so each edge anchors its content to the side it grows from. The notch island
is black whatever the theme, to meet the hardware. Spaces still slide the
window with their animation: Electron offers no stationary collection
behaviour without a native addon.
