# 0188 — Back and forward move between surfaces, and tabs keep their way back

- **Status:** Accepted
- **Date:** 2026-09-29
- **Refines:** 0108 (opening resources), 0154 (profile history)

## Context

A mouse's side buttons worked only inside browser tabs. On a chat, an editor
or Settings they did nothing, although the workspace is where people move
between surfaces all day: a link in a chat opens the file here, the palette
jumps to a workflow, a chat floats over a tab and goes away again. Opening
here never destroys the surface it leaves (it focuses another tab), so the
way back always exists; nothing remembered it. A browser tab reopened with
Cmd+Shift+T, or restored with its window, also lost its own back list.

## Decision

**Each project's workspace remembers the places it was at.** A place is the
focused tab and what floats over it, a chat or a surface. A chat stays open
while the user moves between tabs, so a change to either is a step. The
list is linear, like a browser's: arriving somewhere new drops the places
ahead, and it keeps the latest fifty. It lives in the window's memory and
is not persisted: it answers "where was I a moment ago", while the
profile's history (ADR 0154) answers "what have I seen".

**Back and forward go where clicking would.** The tab is selected as a
click selects it, so a split it belongs to stays; what floated over it
floats again. A part since closed, or since moved (a chat put into a tab,
or taken out of one), stays as it is now, and a place that would change
nothing is skipped. Arriving by back or forward is not a visit: the entry
takes the place as it turned out, and the way forward stays.

**A browser keeps its own pages.** A press on a browser's page or its
toolbar (wherever the toolbar renders; it carries its tab's key) walks that
browser's web history and stops at either end. A press anywhere else (a
chat, floating or in a tab, the sidebar, the tab strip) walks surfaces, so a
browser in front never traps the user, and a press on an open dialog does
nothing. macOS delivers the buttons to what is under the pointer; Windows
and Linux report them as the window's app commands, routed by what has
focus. The three-finger swipe still turns the front browser's pages. The
model is pure (`lib/surface-history.ts`); the host owns input and routing.

**A browser tab's back list rides on its workspace entry.** After each
navigation the tab reads its guest's history (addresses and titles, at most
fifty entries, most of them behind) into its entry, so closing the tab
snapshots it and the workspace persists it. Chromium restores a history
only into a guest that has loaded nothing, and a `<webview>` loads its
`src` as it attaches, so a reopened or restored tab's webview carries the
history as a `work-history:` source. Main recognizes it in
`will-attach-webview`, clears the source, and restores the history into the
guest attached right after; if that fails, the tab loads its page.

Rejected: sending every press to the browser in front, even on a chat
floating over it or on the sidebar (the user could never leave the tab by
mouse); falling through from a browser's first page to the surface before
it (a browser's history should end where its pages end, as in Chrome);
mounting the webview without a source and restoring after (Electron creates
no guest until the source is set); and a staging registry in main keyed by
token (the source already travels with the attach).

## Consequences

Surfaces that replace one another in place (a reused clean editor or
browser) are one place; going back does not restore their previous
content. The detached dock window has no workspace and ignores the buttons.
Page state (scroll position, form values) is not kept; a restored page
loads fresh. A keyboard binding can reuse the same navigation later.
