# 0290: Restarts commit cancellation and replacement together

- **Status:** Accepted (amends 0027)
- **Date:** 2026-10-28

## Context

Keyed enrollment with `onConflict: "restart"` prepared its source first,
then committed cancellation before inserting the replacement. An allocation,
job initialization or database failure could leave no active journey. The
code review control-plane audit identified this gap; the user approved making
replacement atomic rather than requiring each application to repair it.

## Decision

Prepare immutable source and validate admission before a transaction. In that
transaction lock and recheck the observed active run, cancel its hierarchy
through the existing coordinator, revoke its grants and execution leases,
and insert the replacement allocation, run and first job. A rollback preserves
the old run and its authority. A competing replacement is a conflict, not
permission to cancel the competitor's new run.

The coordinator's existing cancellation operation accepts a caller transaction;
there is one implementation for ordinary cancellation and replacement. Runtime
cancellation happens only after commit. Physical cleanup remains subject to
its existing teardown and capacity-release fences; allocation failure does not
free physical resources or sacrifice the old run.

A restart is a replacement request, not permanent business deduplication.
After an uncertain response callers can inspect the active correlation key;
application operation identities remain responsible for distinguishing a retry
from an intentional later generation. We do not promise exactly-once external
requests or reuse the canceled run's credentials for the new generation.

## Consequences

Failures after cancellation but before initialization no longer strand the
subject. Tests inject initialization failure, race restarts and check lease,
child and pause rollback. A full physical node may refuse replacement until
capacity exists; refusal leaves the old run intact. Logical active-run limits
still permit a replacement when a tenant's limit was lowered below its load.
