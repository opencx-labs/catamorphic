# 0188 — Back and forward move between surfaces

- **Status:** Accepted
- **Date:** 2026-09-29
- **Refines:** 0108 (opening resources), 0154 (profile history)

## Context

A mouse's side buttons worked only inside browser tabs. On a chat, an editor
or Settings they did nothing, although the workspace is where people move
between surfaces all day: a link in a chat opens the file here, the palette
jumps to a workflow, a chat floats over a tab and goes away again. Opening
here never destroys the surface it leaves (it focuses another tab), so the
way back always exists; nothing remembered it.

## Decision

**Each project's workspace remembers the places it was at.** A place is the
focused tab and what floats over it, a chat or a surface. A chat stays open
while the user moves between tabs, so a change to either is a step. The
list is linear, like a browser's: arriving somewhere new drops the places
ahead, and it keeps the latest fifty. It lives in the window's memory and
is not persisted: it answers "where was I a moment ago", while the
profile's history (ADR 0154) answers "what have I seen".

**Back and forward put both parts back.** Going back focuses that tab and
floats what floated over it; anything since closed is left out, and a place
with nothing left is skipped. Moving through the list is not a visit.

**A browser keeps its own pages.** A press that lands on a browser's page
or toolbar walks that browser's web history and stays there at either
end. A press anywhere else (a chat, floating or in a tab, the sidebar, the
tab strip) walks surfaces, so a browser in front never traps the user. Presses inside a web page go through
the guest preload as before. macOS delivers the buttons to the page under
the pointer; Windows and Linux report them as the window's app commands,
routed by what has focus. The model is pure (`lib/surface-history.ts`); the
host owns input and routing.

Rejected: sending every press to the browser in front, even on a chat
floating over it or on the sidebar (the user could never leave the tab by
mouse), and falling through from a browser's first page to the surface
before it (a browser's history should end where its pages end, as in
Chrome).

## Consequences

Surfaces that replace one another in place (a reused clean editor or
browser) are one place; going back does not restore their previous
content. The detached dock window has no workspace and ignores the buttons.
A keyboard binding can reuse the same navigation later.
