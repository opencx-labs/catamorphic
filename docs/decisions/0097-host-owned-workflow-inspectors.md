# 0097: Hosts own workflow inspectors and authoring actions

- **Status:** Accepted
- **Date:** 2026-09-07

## Context

The desktop composed the graph with an old packaged Details/Code sidebar.
Its fixed layout and action vocabulary imposed product decisions on hosts,
while users had no clear path from understanding a workflow to changing it
or running a published version. Opening the sidebar also remounted React
Flow and reset the user's viewport.

## Decision

The host owns workflow overview, step details, source editor placement,
authoring, run setup, and automation controls. Remove the packaged
`DetailPanel` and its styles. The optional `WorkflowEditor` composition
accepts a host `renderInspector` slot instead of a built-in sidebar or
source-editor slot. Monaco remains a registry item; selection and source
linking remain headless in `@catamorphic/react` (ADR 0011).

The desktop uses one inspector for Details, Code, Runs, and automation.
Human descriptions, input provenance, and actions lead; expressions and
source locations are deliberate technical affordances. Creation and prose
editing use the existing chat flow. Saving edits a draft; publishing the
project and enabling automatic runs remain explicit, distinct actions.

The reusable canvas reconciles layout changes without remounting or fitting
the viewport again. Positions, container dimensions, and visibility animate
together for 220ms, including connected edges. Reduced motion settles
immediately. View identity is derived separately from parser ids, which
remain unchanged for execution. Parsing retains the last valid graph on
failure, exposes its status, and ignores superseded requests.

## Consequences

Hosts can design an inspector without inheriting desktop doctrine. Existing
embedders using `DetailPanel`, `showCodeEditor`, or `renderCodeEditor` must
compose their own inspector. Drafts live in the desktop workspace snapshot
and survive tab/project switches and relaunch; conflicting external changes and unsaved tab closure are visible decisions. Graph motion
and parse correctness remain shared framework mechanics, tested independently
of the desktop layout.
