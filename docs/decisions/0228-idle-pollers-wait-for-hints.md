# 0228 — Idle pollers wait for hints from their own process

- **Status:** Proposed (refines [0193](0193-no-cross-replica-state-in-replica-memory.md) and [0197](0197-agent-sessions-are-an-event-log-of-turns.md))
- **Date:** 2026-10-13

## Context

People saw Work use a steady 10% of a core in its main process and 6% in
its window with nothing happening. Measured in the isolated test desktop
(`docs/performance.md`), an idle Work with no project ran 19 PGlite
statements a second on Electron's main thread; with a chat open, 37:

- Fixed-interval pollers in core: the workflow worker every 500 ms, the
  agent worker, event delivery and the event-monitor worker every second,
  each a few statements whether or not anything was queued.
- The session feed polled every 150 ms while any chat stream was open,
  streaming or not.
- Every discarded session artifact was looked at again on every sweep,
  forever: a ref listing (a `lstat` and `git` processes) and three
  statements a second each, 0.4% of a core per artifact.
- The window read its chat lists three times every two seconds and
  showed a refreshing spinner for each read, rendering the sidebar.

A streamed answer cost a transaction (about ten statements) and a stream
message per model delta.

## Decision

**Writers hint; pollers still read Postgres.** Core keeps one
`WorkWakeups` per process. A writer that queues work in Postgres hints
its topic after writing: `execution` (a job enqueued or made available),
`agent` (a queued turn), `events` (a project event or monitor),
`sessions` (any session event) and `chats` (one chat lists show). Hints are never the record and carry
nothing (no LISTEN/NOTIFY, ADR 0193): work another process wrote is found
at the next poll as before.

**Pollers pace themselves.** Each loop polls at its quick cadence while
it finds work or got a hint in the last two seconds (a hint can precede
its writer's commit), and at the host's `idlePollMs` otherwise. A hint
ends an idle wait at once; so does the next known due time (a delayed
job's or queued turn's `available_at`). Without `idlePollMs` nothing
changes, so hosts with several replicas keep today's latency for work
another replica writes. The desktop, where every write is its own, sets
5 s.

**Streams batch.** The turn engine records streamed text and output
deltas that arrive within 100 ms as one batch (the ingest already folds a
batch into one append per item); streams deliver no faster than the
150 ms feed.

**Retired artifacts are revisited rarely.** A sweep reclaims each newly
retired artifact once; a reclaimed one is looked at again for late
candidate refs every ten minutes. A writer that finds its artifact
discarded drops its own candidate.

**The desktop's windows follow hints.** Main tells its windows "chats may
have changed" after a session event chat lists show (`chats`: anything but
streamed text and progress on an item) or any change through its API (one
message per burst, at most every 1.5 s). Local chat lists, attention and
watchers read again then, with a 30 s safety poll; remote projects keep
their polls. A routine read never shows a refreshing state: the sidebar
renders only when rows change.

Considered: LISTEN/NOTIFY (refused by 0193, and PGlite and poolers make it
uneven); longer fixed intervals (slower runs and chats for no reason); a
project-level change stream in the API (a new public surface for what one
process can say in memory).

## Consequences

On the test desktop (`apps/desktop/docs/performance.md`), idle
main-process CPU fell from 8.4% to 2–4% of a core without a project and
from 10.7% to 2.4% with a chat open; idle statements fell from 37 to 6 a
second, the window stopped rendering at idle, and a live turn writes 80
statements a second instead of 171. Work written by another process
waits up to `idlePollMs` on a paced host. A chat-list change that is
neither a session event nor an API request (none known today) shows within
30 s. The Work server can adopt pacing once measured with its replicas.
