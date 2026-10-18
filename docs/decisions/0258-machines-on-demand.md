# 0258 — Machines on demand

- **Status:** Accepted
- **Date:** 2026-10-18
- **Refines:** 0173, 0193, 0205

## Context

Pull request reviews run as keyed project chats in a `review` Environment,
each holding a large machine for about half an hour, and arrive in bursts.
Machine rules (ADR 0205) gave machines per member or a fixed number per
group, and nothing recorded that work was waiting for one: a new chat with
no machine free failed at admission, and a chat whose workspace was given
back stayed queued while the agent sweep tried admission every second. The
reconciler also checked that a machine had no workspaces and then revoked
it, so an Allocation made in between landed on a machine being destroyed.

## Decision

**Work waits for a machine, in Postgres.** `placement_waits` holds each piece
of work admission could not place (`capacity`: no machine open to it has
room; `unavailable`: none is online), with its Environment, pool, owner and
needs, on the database clock. The transaction that creates the work's
Allocation deletes it, closing its chat deletes it, and so does a drain that
finds nothing of it queued. Retries back off from 5 to 30 seconds; a worker
connecting makes every wait due at once. A wait not tried for two minutes is
not demand (its process stopped), and one untried for ten is forgotten.

**An Environment says how long work may wait.** `"waitMinutes": n` lets a new
chat start without a workspace when no machine is free: its turns wait, and
fail once it waited `n` minutes, saying why; the next message waits again.
`0`, the default, fails a new chat at once, as before. A chat already open
whose workspace was given back always waits, as before, now recorded; with
`waitMinutes` it also gives up after that long.

**Rules scale with demand.** `machines: { demand: { max, min, idleMinutes,
enrollMinutes } }` (defaults 0, 10, 15) serves a `group`'s members, or the
own work of named `projects` (machines opened to those projects, ADR 0173);
a rule names exactly one. A pass keeps machines still enrolling, holding
capacity, or idle for less than `idleMinutes` (idle since the later of
enrollment and the last capacity given back), then the most recently idle up
to `min`. Work matching the rule (its labels, class and `plane: worker`
satisfy the pool, and its access takes the owner) that no kept machine has
room for, beyond one piece per machine still enrolling, gets new machines,
up to `max`. Each wait counts for one rule, the first by name. A machine that
does not enroll in `enrollMinutes`, or holds work but has not called for that
long, is replaced. Machines not wanted are released and destroyed at once
(`retainDays` is 0). Only `hetzner-cloud` and `custom` classes scale; pool
classes are refused.

**Drain under the node lock.** Revoking a machine locks its node row, counts
Allocations holding its capacity, and disables it only when there are none;
creating an Allocation takes the same lock and needs the node enabled. A
machine that is not connected is still revoked at once.

**The provisioner stays the platform seam.** A `custom` class carries an
opaque `options` object that `create` receives unread, with the rule name
and, for a machine made for waiting work, that work's resources and
capabilities. `create` must be idempotent by name and `destroy` must find a
machine by name, since an uncertain failure leaves Work not knowing whether
it exists. Work ships no cloud SDK for this.

**Cadence.** With demand rules, each replica looks at demand every 10 seconds
with one statement and starts a pass when it changed; idle machines go on
the 60 second pass. A rule's status counts its `queued` work.

Considered: autoscaling from queued turns alone (it misses new chats, which
fail before any turn exists), and a cloud autoscaling group (it cannot tell
which work a machine may take, and Work would still need to drain safely).

## Consequences

A review burst creates machines and an idle one goes after ten minutes.
Work whose needs the class cannot meet makes a machine every `idleMinutes`
until `max`; the rule's status shows it queued. A `sendMessage` caller still
stops waiting after five seconds unclaimed; deliveries are unaffected.
