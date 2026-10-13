# 0228 — Idle pollers wait for hints from their own process

- **Status:** Accepted (refines [0193](0193-no-cross-replica-state-in-replica-memory.md), [0197](0197-agent-sessions-are-an-event-log-of-turns.md) and [0207](0207-operations-are-sealed-to-their-executor.md))
- **Date:** 2026-10-13

## Context

People saw Work use a steady 10% of a core in its main process and 6% in
its window with nothing happening. Measured in the isolated test desktop
(`docs/performance.md`), an idle Work with no project ran 19 PGlite
statements a second on Electron's main thread; with a chat open, 37:
fixed-interval pollers in core (the workflow worker every 500 ms; the
agent worker, event delivery and the event-monitor worker every second;
the session feed every 150 ms while any chat stream was open), every
discarded session artifact looked at again on every sweep, forever, and
the window reading its chat lists three times every two seconds, showing
a refreshing spinner each time. A streamed answer cost a transaction
(about ten statements) and a stream message per model delta.

## Decision

**Writers hint; pollers still read Postgres.** Core keeps one
`WorkWakeups` per process: ADR 0207's local wakeups, keyed here by topic
(`OperationWakeups` keys the same class by executor and by operation). A
writer hints its topic after writing: `execution` (a job enqueued or made
claimable: a resumed run, an authorized connection), `agent` (a queued
turn), `events` (a project event, a monitor or its watcher), `sessions`
(any session event) and `chats` (what chat lists, attention and watchers
show: a session event other than streamed text, a chat created, its
visibility, attention, icon or watchers). Hints carry nothing and are
never the record (no LISTEN/NOTIFY, ADR 0193): work another process
wrote is found at the next poll.

**Pollers pace themselves.** Each loop waits after each poll: its quick
interval while it finds work or heard a hint in the last two seconds, the
host's `idlePollMs` otherwise. A pacer hears its topic from its loop's
start to its stop, as a wakeup is subscribed before Postgres is read: a
hint ends an idle wait at once, and one that arrives mid-poll makes the
next wait quick. A hint never ends a quick wait, so a run of hints polls
no faster than the quick interval. A hint inside a transaction can
precede its commit; the poller then stays quick long enough to read it
(on PGlite its read waits for the transaction anyway). A session command,
which owns its transaction, hints after it commits. An idle wait also
ends when known work falls due: a job's `available_at` or lapsing lease,
a queued turn's `available_at`, an active turn's lease, a request's
deadline, a watched monitor's next poll. Watcher expiry (with event
delivery) and maintenance sweeps (lapsed job leases are requeued at most
every 5 s) wait for their loop's next poll. Without `idlePollMs` loops
keep their quick intervals, so hosts with several replicas keep their
latency for work another replica writes; the agent worker and session
feed now wait after a poll instead of starting one on a fixed interval.
The desktop, where every write is its own, sets 5 s.

**Streams batch.** An item's first streamed delta is recorded at once;
later deltas that arrive within 100 ms are recorded as one batch with one
more read that does not wait (the ingest folds a batch into one append
per item). A runner on a remote worker is read through a forwarded
operation, so a batch costs one extra short read where every delta
previously ended a long read. Streams deliver no faster than the 150 ms
feed.

**Retired artifacts are revisited rarely.** A sweep reclaims each newly
retired artifact once; a reclaimed one is looked at again every ten
minutes, and one whose reclaim failed after a minute.

**The desktop's windows follow hints.** Main tells its windows "chats may
have changed" on a `chats` hint or a request on a route that changes chat
lists (one message per burst, at most every 1.5 s); other project
requests (an app's calls and storage, terminals, MCP) never do. Local
chat lists, attention and watchers read again then, and when a hidden
window shows again, with a 30 s safety poll; remote projects keep their
polls. A routine read never shows a refreshing state.

Considered: LISTEN/NOTIFY (refused by 0193, and PGlite and poolers make it
uneven); longer fixed intervals (slower runs and chats for no reason); a
project-level change stream in the API (a new public surface for what one
process can say in memory).

## Consequences

On the test desktop, idle main-process CPU fell from 8.4% to 2–4% of a
core without a project and from 10.7% to 2.4% with a chat open; idle
statements fell from 37 to 6 a second, the window stopped rendering at
idle, and a live turn writes 80 statements a second instead of 171. Work
written by another process waits up to `idlePollMs` on a paced host. The
Work server can adopt pacing once measured with its replicas.
