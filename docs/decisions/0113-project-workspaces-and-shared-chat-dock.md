# 0113 - Persistent project workspaces and a shared chat dock

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

## Consequences

Background work retains its browser and terminal resources. Explicit routing
prevents duplicate tools and conflicting workspace writers. Live workspaces
consume resources until disposed; hiding is distinct from disposal. Native dock
behavior is adapted to platform capabilities and never changes execution.
