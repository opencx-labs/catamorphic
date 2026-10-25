# 0284: Workspace windows restore as one saved set

- **Status:** Accepted
- **Date:** 2026-10-25

## Context

The app saved one geometry record, although several workspace windows could own
different project groups and profiles. Each window overwrote that record, and
restart opened one window using a profile-wide last project. The person asked
for every open workspace window to return after Quit or an update restart.

## Decision

Extend the existing app-owned `window-state.json` store into one workspace-window
collection. Every entry has a stable window id, profile, owned project ids, active
project, normal bounds, maximized/fullscreen modes, visibility and minimized state.
The collection also records the last focused window. Detached docks, voice
bubbles, extension windows and sign-in popups keep their existing lifecycles.

`DesktopWorkspaces` remains the one project-ownership authority. Before renderer
loading, reserve the saved project groups in that authority. Each renderer mounts
all of its reserved projects and restores their contents through the existing
per-project workspace store. Never duplicate tabs, drafts or layout in the window
file. Restore native placement against the current displays and focus the last
visible, non-minimized workspace once all workspace windows are ready.

Before Quit or update teardown, each initialized workspace renderer flushes its
registered project savers and acknowledges completion. The ordinary 500 ms saves
and this flush share an ordered write queue to the existing project store. Only
then freeze the complete window collection and permit native teardown. A failed
update, declined move or prevented native close resumes persistence for a retry.
Validate saved owners against real project records before mounting them; deleting
a project forgets its claim and runtime. Occupied close still hides the window and
keeps its resources; a truly closed empty window leaves the collection. The palette
uses that same native close lifecycle.

## Consequences

Restart preserves the person's grouping across profiles without competing owners
or a second persisted tab model. Window state stays machine-local, while project
contents retain their existing persistence. The previous singleton geometry format
is replaced; invalid records fall back to a fresh workspace window.
