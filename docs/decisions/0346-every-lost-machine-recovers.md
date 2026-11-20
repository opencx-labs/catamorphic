# 0346 — Every lost machine recovers

- **Status:** Accepted
- **Date:** 2026-11-20
- **Amends:** 0173, 0190, 0192, 0205, 0258

## Context

A member's kept machine (an `each-member` rule, EC2) was terminated. Its rule
went on reporting `ready: 1`, its worker `serving`, and nothing replaced it:
only machines on demand were ever checked for loss, status never read the
lease, and node recovery (ADR 0190) skips enrolled workers. After an operator
revoked it, the replacement enrolled under the same name and node id and
inherited the dead machine's Allocations: every chat failed every message
with the runner's internal "Sandbox does not belong to this runner
connection", and the dead sandboxes held the new machine's capacity.

## Decision

**Loss is one rule for every enrolled machine.** A machine that was serving
and has not renewed its lease is `unreachable`; unseen for its loss limit it
is `lost`. The limit is the rule's `lostMinutes` (default 5, at least 2), or
the default for a worker no rule manages. `enrollMinutes` keeps its meaning
for a machine on demand that never connected. Rule status (`ready`,
`starting`, `unreachable`, `lost`) and worker `state` (`serving`,
`connecting`, `unreachable`, `lost`) read the lease by the database's clock.

**A machine's end reaches its work in one place.** `retireNodeWork` in
`node-recovery-service.ts` releases every active Allocation on the node as
`node_lost` with its capacity, grants and runtimes, clears its chats'
sandboxes, records `session.workspace-changed` (`lost`, `machine-lost`),
frees the capacity of Allocations already released there, and marks the
node's cache copies evicted. It runs under the rows' own locks in the order
chats take them, so any replica may call it any number of times (ADR 0193).
It is called when maintenance on any replica finds a lost or revoked machine
that still holds something, by `revoke`, by a drain's lost branch, by the
reconciler's lost transition, and inside `enroll`, in its transaction, where
a name gets its node back as a new machine. Node ids and epochs are unchanged.

**A rule replaces what it provisioned.** A lost machine its rule still wants
is revoked under its node's lock only while still unseen, destroyed through
its provisioner until done, then created again under a new enrollment and
idempotency key, in the same pass when the platform answers at once. A newly
lost machine starts a pass within seconds. `machine.lost` is recorded for
every rule's machine, and `machine.created` for its replacement.

**Chats continue by themselves.** A queued message, or one whose attempt had
not started, is admitted again on the replacement or any machine open to its
owner and its workspace rebuilt from the session's last save, as after an
idle release; the chat's transcript says its machine was lost, its workspace
was rebuilt from its last save, and work since then is gone. A turn at work
ends failed or interrupted naming the machine, and no longer waits for the
next message to be settled.

**The runner's refusal is typed.** `RemoteSandboxUnknownError` replaces the
raw words; where an Allocation's sandbox operation meets it, that one
Allocation is retired and the chat admitted again.

**Workers no rule manages are not replaced.** Their work is retired at the
loss limit, so their chats run on another machine open to their owner or
wait. A worker that returns with its disk removes the sandboxes whose
Allocations are gone and takes work again. Considered and rejected: keeping
their Allocations until an operator acts (the incident), and new node ids per
enrollment (a wider change to placement and the worker protocol).

## Consequences

Work done after a chat's last save is lost when its machine is unseen for
the limit, even if the machine returns later; raise `lostMinutes` where
outages are long and work is costly. A lost pooled machine keeps its place:
its work is retired, but another free machine is not assigned in its stead.
Machine classes, provisioner contracts, stop and resume, and ownership are
unchanged and belong to the machine model's redesign.
