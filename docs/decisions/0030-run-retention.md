# 0030 — Run retention

- **Status:** Accepted
- **Date:** 2026-07-26

## Context

0029 named this as the largest remaining risk: nothing purged finished work.
`execution_jobs`, `workflow_run_events`, `workflow_step_attempts`,
`batch_items`, `batch_item_steps`, and `batch_step_members` grew monotonically,
and because `workflow_runs` was never deleted, every `ON DELETE CASCADE` in the
schema was unreachable — the cascades were written but nothing ever triggered
them.

The scale is set by batch work. One 100k-item batch through a five-node pipeline
writes on the order of 1.5M rows. Run daily, that is hundreds of millions of
rows a year, and the index load is worse than the heap: `batch_items` carries
five indexes, `batch_item_steps` a six-column unique over two varchars.

## Decision

**Retention is on by default, at 90 days.** The alternative — off until
configured — leaves every installation that does not read the docs with exactly
the unbounded growth this exists to prevent. A greenfield project takes 90 days
to reach the first purge, which is ample time to change the window or disable
it.

**`workflow_runs` is the only thing deleted.** Everything else hangs off it by
`ON DELETE CASCADE`, so one bounded delete of terminal root runs reclaims the
whole tree. No per-table sweep, no ordering problem, no chance of orphaning a
child table when a new one is added later.

**The window is configurable at two levels**, matching how every other limit
here already works: `retention` on the core/SDK config sets the installation
default, and `tenant_execution_policies.retention_days` overrides it per tenant.
Like the rest of that table it is host-owned and unreachable over HTTP — a
tenant must not be able to extend its own retention and grow shared storage
without the host agreeing.

**The sweep rides the execution worker's poll loop** on a slow timer (hourly by
default), one bounded batch at a time. If you run workers, retention happens. It
inherits the loop's error handling and shutdown, never holds more than one
statement's worth of work, and a large backlog drains over successive sweeps
rather than in one long transaction. The timer is shared across loops in a
process, so N concurrent loops still sweep once per interval.

**Two guards decide what is purgeable.** Only root runs are considered — a child
whose parent is also expiring would otherwise be deleted twice, once directly
and once by the parent's cascade. And a run with any non-terminal descendant is
skipped entirely: a parent can reach a terminal status while a descendant is
still live (the parent failed before its child was cancelled), and cascading
onto that descendant would destroy in-flight work.

**The descendant check is recursive, because the cascade is.** The first
implementation checked direct children only, which was wrong in a way worth
recording: a root whose own child was terminal looked purgeable, and the delete
then cascaded *through* that terminal child onto a still-running grandchild.
Depth-one reasoning does not hold against a depth-N cascade.

## Consequences

The sweep is flat at ~2.8ms from 10k to 300k runs of history, and both new
indexes resolve as index conditions with zero rows filtered.

Getting there required restructuring the query, which is the part worth
recording. The obvious form — join `projects` and `tenant_execution_policies`,
compare `completed_at` against `COALESCE(policy.retention_days, default)` —
**cannot use an index**, because the comparison depends on a joined column. It
planned as a sequential scan filtering all history: 3.8ms at 10k rising to 82ms
at 300k, linear in exactly the dimension retention is supposed to bound.
Resolving each project's cutoff instant in a leading CTE and then joining
`LATERAL` makes the comparison a per-project constant, which the index can seek
on. The index existed in both versions; only the shape of the predicate decided
whether it was usable.

The descendant walk has the same shape of trap. Written the obvious way — a
correlated `WITH RECURSIVE` inside `NOT EXISTS`, evaluated per candidate — it
costs about 50× more (~20ms versus 0.35ms on the same data), because the CTE is
re-planned and re-executed for every row. Walking the whole candidate batch once
as a set and anti-joining the blocked roots restores it to ~0.7ms while keeping
full recursive protection. Both formulations are correct; only one is usable.

`idx_workflow_runs_retention` is partial on the terminal statuses, so it indexes
only purgeable rows and stays small relative to the table — live runs, which the
hot paths read, are excluded from it entirely.

Hosts that need to keep history indefinitely set `{ enabled: false }` and take
responsibility for growth. Hosts selling tiered plans attach `retentionDays` to
their tier logic alongside `maxActiveRuns` and `queueWeight`.

Purged history is gone, not archived. An archive-then-delete hook was considered
and rejected for now: streaming 1.5M rows per batch through JS, with its own
failure semantics when the sink is unavailable, is a much larger surface than
this problem requires. It remains addable later without changing this design,
since the delete is already funnelled through one method.

`uq_execution_job_dedupe` — flagged in 0029 as the first index expected to
degrade, because it retains an entry for every job ever enqueued — is now
bounded by retention rather than growing forever. The heartbeat write
amplification noted there is unaffected and still open.
