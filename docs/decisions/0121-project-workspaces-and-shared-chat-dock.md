# 0121 - Persistent project workspaces and a shared chat dock

- **Status:** Accepted
- **Date:** 2026-09-10

## Context

Changing the visible project unmounted chat composers, browsers, and terminals.
Agent workspace tools broadcast to whichever window had the project active.
A dock spanning projects and native windows requires explicit ownership.

## Decision

Each project has one live workspace owner in the desktop application. Windows
select a visible project while other open project workspaces remain alive.
Opening an already owned project in another window focuses its owner. Closing
presentation surfaces never implicitly interrupts an agent.

Chat presentation is shared within a profile. The same chat UI serves attached
and detached presentation; execution and transcripts remain in core. Routing
includes project and chat identity, never the currently visible project.
Desktop presentation state does not become part of the framework domain model.

Profile preferences independently select current-project or multi-project dock
scope, attached or detached placement, and left or right edge. Project theme
resolution follows defaults, profile, shared project settings, then personal
project settings. Missing values inherit; a selected preset resets inherited
colors before the layer's token overrides. Settings live outside workflow code.

Cross-project navigation reveals the target before focusing its surface, with a
brief low-opacity theme tint and no spatial movement; reduced motion disables it.

Amended 2026-10-14: a window keeps every project it has shown alive behind the
one in front, so "open in a new window" focused that same window. Asked to open
a project in a new window, a window that keeps it in the background now lets it
go: the project unmounts there (its workspace saved as it was, unsent chats and
their drafts included, handed to the new window in memory rather than saved) and
opens in a new window that owns it from creation. Its shells on this computer keep
running and the new window's tabs take them over with their output
(`catamorphic:terminal-adopt`, only by that window and only for shells handed off,
which end if nothing takes them within 30 seconds); a remote chat's shell opens
again on its server below what it printed; web pages load again with their
history. Agent calls for the project wait until the new window has opened it. A file's
unsaved edits live only in its editor, so a project holding some stays where it
is and that window says so. A project in front of a window is already in one, and
that window comes forward. New windows cascade from the window they came from,
are named for their project, and macOS lists them in the Window menu, where
Cmd+` moves between them.

## Consequences

Background work retains its browser and terminal resources. A project moved to a
window of its own keeps its shells and chats; its pages reload. Explicit routing
prevents duplicate tools and conflicting workspace writers. Live workspaces
consume resources until disposed; hiding is distinct from disposal. Native dock
behavior is adapted to platform capabilities and never changes execution.
