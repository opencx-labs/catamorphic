# 0134: Consent binding and collection lifecycle

- **Status:** Accepted
- **Date:** 2026-09-11
- **Refines:** 0103, 0132, 0133

## Context

Live capability sources reconstructed an operation after consent and executed
that replacement without binding it to the approved policy. Sidebar trees also
split acquisition from presentation: hidden views refreshed retained pages and
children, while item-only updates could leave sorted projections stale.

## Decision

Capability definitions carry a host-local execution revision and a consent key
when approval is required. Live sources version their target and policy snapshots
separately. Core compares these together with schemas, effect and normalized input
after approval and activity hooks. Changed execution or a new/different consent
requirement fails before execution and requires a fresh invocation. Removing a
requirement, including “Always allow”, preserves the approved call. Consent never
transfers to a replacement definition. Live identity, allocation and owning
service authorization remain mandatory. Revisions are not part of model-facing
schemas or telemetry.

Collections reference-count each acquired branch. Visible trees own their root
and expanded, reachable branches; collapse and hide release requests while
retaining snapshots. Trees with filters, grouping or sorting subscribe to item
snapshots as well as topology. Unprojected trees retain individual-row updates.

Desktop built-ins and guest adapters share session page IO through the host query
cache. Hidden views acquire the same collection in preview mode, refreshing only
the first matching root page. Full owners restore the previously loaded depth.
One content snapshot determines availability, avoiding feedback between stale
hidden and visible caches. Guest widgets use the same lease modes over their
granted host source. Source subscriptions remain host-neutral and reference-counted.

## Consequences

This is a breaking authoring cleanup: capability authors specify revisions and
collection projections no longer require source-specific structural keys.
Regression coverage crosses consent changes during async hooks, shared reads,
visibility, lazy branches and item reordering. No compatibility path is retained.
