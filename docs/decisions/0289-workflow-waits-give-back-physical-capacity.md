# 0289 — Workflow waits give back physical capacity

- **Status:** Accepted
- **Date:** 2026-10-28

## Context

A durable pause keeps a run's journal and deployed revision, but currently also
keeps its Allocation's workspace, CPU and memory reserved. Enough waiting roots
can prevent independent cleanup workflows from starting. Children and batch work
share the root's Allocation, so releasing on one waiting boundary alone is unsafe.

## Decision

Reuse the Allocation lifecycle. Once a root and its sharing children have no
running jobs, registered invocations or runnable compute, retire their Allocation
with reason `idle` and revoke its grants. The existing node cleanup destroys the
workspace; only confirmed destruction releases capacity. Failed or uncertain
teardown retains the reservation. A durable wait needs no filesystem continuity.

Resolve pause timeouts as control-plane jobs, without a workspace. Before further
compute is claimable, admit a fresh Allocation using the owner's current authority,
the same Environment and the run's existing connection selection. Check connection
authority again; never silently select replacement credentials. Repoint sharing
runs atomically under the root's lock. The deployed artifact and execution journal
remain unchanged. Unavailable machines/capacity wait; revoked authority fails the
run tree. Queued continuations reuse `placement_waits` and the host's ordinary
machine demand rules; timeout jobs and parked journals are not demand.
Reconciliation uses the existing worker/recovery lifecycle and database
fences, including after crashes, rather than a second reservation system.

## Consequences

Waiting roots no longer monopolize compute. A continuation may use another machine
and rebuilds from its pinned deployment. Files outside declared persistent storage
do not survive a wait. Children and batch items retain shared admission while any
of their compute is runnable. Cloud resource cleanup remains application code:
parking or cancellation cannot undo external effects.
