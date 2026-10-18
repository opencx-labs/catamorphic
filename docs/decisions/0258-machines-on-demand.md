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
Allocation deletes it, and so do closing or archiving its chat (which
withdraws its queued work) and a drain that finds nothing of it queued.
Retries back off from 5 to 30 seconds; a worker connecting makes every wait
due at once. Only a wait with a queued turn, tried within two minutes, is
demand; one untried for ten is forgotten.

**An Environment says how long work may wait.** `"waitMinutes": n` lets a new
chat start without a workspace when no machine is free, in the first
Environment in admission order that lets work wait: its turns wait, and fail
once it waited `n` minutes, saying why; the next message waits again. `0`,
the default, fails a new chat at once, as before. A chat already open whose
workspace was given back always waits, now recorded; with `waitMinutes` it
also gives up after that long. A waiting chat whose Environment can no
longer take it at all (removed, invalid, refused, incompatible) fails its
due turns with that error. A message sent and awaited (`ask_agent`) answers
at once that the chat waits for a machine.

**Rules scale with demand.** `machines: { demand: { max, min, idleMinutes,
enrollMinutes } }` (defaults 0, 10, 15) serves a `group`'s members, or the
own work of named `projects` (machines opened to those projects, ADR 0173);
a rule names exactly one. A pass keeps machines still enrolling, enrolled
and still connecting, holding capacity, or idle for less than `idleMinutes`
(idle since the later of enrollment and the last capacity given back), then
the most recently idle up to `min`. A machine not seen for `enrollMinutes`
(since its last call, or since it enrolled when it never called) is lost and
replaced. Work matching the rule (its labels, class and `plane: worker`
satisfy the pool, and its access takes the owner) that no connected machine
has room for, charged its resources or the machine's defaults, beyond one
piece per machine still enrolling or connecting, gets new machines, up to
`max` counting machines the rule served under an earlier group or projects
until they go. Each wait counts for one rule: the first by name whose
connected machines do not report that they cannot take it (checked as
admission checks it); a rule whose machines fall short says so in its status
and leaves the work to the next. Machines not wanted are released and
destroyed at once (`retainDays` is 0). Only `hetzner-cloud` and `custom`
classes scale; pool classes are refused.

**A machine that never connects stops its rule.** When a machine enrolled
since the rule was last written and has not connected within
`enrollMinutes`, the rule makes no more machines until it is written again,
and its status says why. An untrusted rule serving several owners is
refused when it is written if machines of its class are known to run plain
processes, which such a machine could never connect with.

**Drain under the node lock.** Revoking a machine locks its node row, counts
Allocations holding its capacity, and disables it only when there are none;
creating an Allocation takes the same lock and needs the node enabled. A
machine holding workspaces is revoked anyway only when it is not connected
and has not called for `enrollMinutes` (15 minutes for other rules), not on
one lapsed lease.

**The provisioner stays the platform seam.** A `custom` class carries an
opaque `options` object that `create` receives unread, with the rule name
and, for a machine made for waiting work, that work's resources and
capabilities. Work never calls `create` twice with one enrollment code, so
`create` is idempotent per code: `enrollment.idempotencyKey`, a hash of the
code, is the platform's token (an EC2 `ClientToken`), never the name, which
a later machine of the rule reuses (EC2 keeps a token for a day). `destroy`
removes the machine its ref names and every machine with its name, and
answers `{ done }`: Work asks again on later passes and forgets the machine
only once it is done, so a destroy right after an uncertain create leaves
no orphan. Work ships no cloud SDK for this. A Hetzner or custom class
names the sandbox backend its machines run (`"sandbox": "container"`,
passed to the install script as `--sandbox`), since `auto` picks microVMs
wherever KVM is usable and they cannot give setup its own network (ADR
0257).

**Cadence.** With demand rules, each replica looks at demand every 10 seconds
with one statement and starts a pass when it differs from what its latest
pass saw when it started, so demand that arrives during a pass, or while
another replica holds the claim, starts another; idle machines go on the 60
second pass. A rule's status counts its `queued` work.

Considered: autoscaling from queued turns alone (it misses new chats, which
fail before any turn exists), and a cloud autoscaling group (it cannot tell
which work a machine may take, and Work would still need to drain safely).

## Consequences

A review burst creates machines and an idle one goes after ten minutes.
Work no machine of any rule can take shows as queued on no rule and as a
problem on the rules that fall short; until one of a rule's machines has
connected and reported what it offers, such work can still make one
machine. A machine is lost only after `enrollMinutes` unseen, so a dead one
holds its place that long.
