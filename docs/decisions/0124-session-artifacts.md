# 0124: Session artifacts share source ownership and retention

- **Status:** Accepted (review-package distribution superseded by 0126)
- **Date:** 2026-09-11
- **Refines:** 0035, 0053, 0074, 0076, 0101, 0114

## Context

Generated reviews and other interactive results should be ordinary apps, with
shared components and skills. Requiring every result to become a permanent
project app makes that model expensive. Temporary workflows already retain
TypeScript on dedicated refs. Apps need the same session lifecycle.

## Decision

Use one session-artifact source service for temporary apps and workflows. Each
artifact has a stable id, owning session/user, kind, name, selected source paths,
and immutable revisions on a Catamorphic-owned git ref. Files use ordinary Bun
workspace layouts. Source snapshots use an isolated ProjectManager checkout;
they never capture dirty files or modify the user's checkout, index or branch.
Workflow logic stays TypeScript, not metadata. Conflicting workflow exports
inside a snapshot are rejected rather than resolved by name order.

Reuse AppsService, AppMount, RunsService and WorkflowEnablementsService.
Watchers use the same retained source service and pin their activation revision.
A session app builds immediately and opens through an ordinary app address,
qualified by its artifact id. It needs no publication. Static apps have an empty
callable set. Workflow calls and polling carry the mounted build id; helper
workflows run at that build's source revision with the existing permission,
connection and placement checks. Mixed app source scopes are rejected.

Closing a tab has no lifecycle effect. Results remain reopenable with the chat.
Close/archive stops future activations but retains source and built results.
Discard or session deletion makes source eligible for collection after builds
and runs settle. Cleanup retries are persisted. Saving to the project is an
ordinary selected-file change, never an automatic merge, publish or consent.

Generated reviews use ordinary React apps and the optional
`@catamorphic/app/review` entry. The desktop and guests share the diff renderer
and Overview, Guide, Changes, Discussion navigation. Host tokens control feel;
project skills and components can replace the authoring defaults. MDX can be
compiled by a project's app toolchain; there is no additional document runtime.
Native GitHub actions remain in the authenticated host.

## Consequences

One source lifecycle supports two existing execution paths. The shared review
kit carries a bounded offline highlighter; other languages remain readable as
text. Ordinary apps do not stage the review payload. Temporary is a retention
choice, not a privacy or remote-upload grant; personal source under 0068 remains
separate. See the [implementation notes](../superpowers/specs/2026-09-10-session-artifacts-design.md).
