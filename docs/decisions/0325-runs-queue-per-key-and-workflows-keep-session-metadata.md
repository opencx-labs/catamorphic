# 0325: Runs queue per key, and workflows keep state in session metadata

- **Status:** Accepted (amends 0027, 0226, 0259, 0262; supersedes 0292)
- **Date:** 2026-11-17

## Context

A correlation key (ADR 0027) makes a run's subject unique among live runs,
with `ignore`, `error` or `restart` on conflict. Nothing lets one subject's
runs take turns. The review recipe's publisher reads a verdict and then
writes one, so two overlapping `postReviews` runs both read "no verdict" and
posted a failure then a success. ADR 0292 answered with deployment-owned
server code, its own Postgres schema, row locks and two connection pools;
the opencx watcher built its own effects tables and per pull request locks
for the same races. Both are the scheduler's job. Their durable state (the
strongest verdict per commit, posted ids) is a few facts about one chat,
which session metadata (ADR 0226) holds, but workflows could not read or
write it. Trigger kinds also derived their delivery ids (a webhook's id, a
schedule occurrence, a project event) as correlation keys, so a key was
both "this delivery" and "this subject" and a workflow could not choose a
subject of its own. Separately, enablement revalidation reported a full
machine as `environment_denied` and suspended the automation.

## Decision

**A fourth conflict policy, `queue`.** A run whose key already has an active
or queued run is recorded with status `queued`: durable, holding no
Allocation, job, workspace or active-run slot. Enrollment decides under a
transaction-scoped advisory lock on (project, workflow, key) and stamps
`queued_at` there, so arrival order is commit order. When no active run
holds the key, the oldest queued run starts: the runs service resolves its
owner's current authority (the enablement is revalidated; a member's
authority is resolved again), admits it like any run, and in one
transaction under the same lock rechecks that it is still the head and the
key is free, then creates its Allocation and first job. The active-key
index excludes `queued` and stays the authority. Start is attempted after a
run settles, after a cancel, after an enrollment, and on each worker's
maintenance sweep (5 seconds), so a replica that dies mid-start leaves
nothing stranded; replicas racing for one head are fenced by the lock and
the index, and admission reserves nothing until that transaction. A full
machine or the tenant's active-run limit leaves the run queued and retried;
a refused authority fails the queued run, which frees the key for the next.
Cancelling or failing any run frees it the same way. `cancelByKey` and
`signalByKey` address the active run, never a queued one. A key holds at
most 100 queued runs (`RunQueueFullError`).

**A workflow declares its key.** `defineWorkflow` takes static
`concurrency: { key: "<dot path into the run input>", onConflict }` beside
`triggers` and `steps`; the parser records it on the graph like
`permissions`. A run started without an explicit `correlationKey` derives
its key from the path (a string or finite number; any other value, or none,
runs unkeyed). A host caller's explicit key and policy win.

**Delivery ids are delivery keys.** Trigger kinds return `deliveryKey`
(renamed from `correlationKey`), and schedules and the project event
dispatcher pass theirs the same way, each scoped by the enablement or
activation it starts. A run's `delivery_key` is unique per workflow for all
time: a repeated delivery returns the run it started, in any status. Correlation keys now only name subjects.

**Workflows read and write session metadata.** `inspect` and `find`
snapshots carry `metadata`. `setMetadata({ sessionId | key (+ audience),
set: { <key>: value | null } })` is a returned transition applying ADR
0226's merge patch, limits and authority rules through
`AgentSessionsService.setMetadata`; closed and archived chats still take
writes, and a copy without the session's authority refuses. Keys a
workflow owns carry its purpose as a prefix (`review.`), since agents and
people write metadata too.

**Capacity is not authority.** Revalidation treats `EnvironmentCapacityError`
and an offline machine (`EnvironmentBindingUnavailableError`) as "admit
later": the enablement stays active, and the run's own admission waits or
fails retryably as it always did.

**The review publisher is workflow code.** `postReviews` declares
`concurrency: { key: "payload.session.key", onConflict: "queue" }`, so one
publication per pull request chat runs at a time, in turn order. It reads
the turn's newest current `review` result (ADR 0323) from any of its
attempts, and refuses it, saying which, when the commit it names or the
commit Work recorded its turn began on is not the head. GitHub is the
authority: a commit's verdict holds or tightens over the App's own check
runs, and every write goes through the connection's typed actions with a
stamp (ADR 0259), which finds an earlier accepted write on retry. The chat's
`review.verdicts` and `review.posted` metadata is a record written last,
never trusted for what to post, since the reviewer can write its own chat's
metadata; a chat that refuses it fails only that last step. The server
module, its SQL schema, the `company.review-publication` hook and their
install steps are removed. ADR 0292's policies stay: commit-bound reviews
and checks, a commit's verdict only holds or tightens, no unattended
dismissal, description edits or thread resolution. What remains uncertain: a
write GitHub accepted after the attempt timed out is found by its stamp on
the retry, but one GitHub's lists do not show yet can be sent again by that
retry; the queue keeps any other publication for the pull request from
writing meanwhile.

**Queued starts are bounded and fair.** A head that cannot start for a
reason that will not change fails at once; anything else retries with
backoff (`queue_attempts`, `queue_attempted_at`, the last error in `error`)
and fails after 8 tries, freeing the key. Waiting for room has no bound and
is retried every 5 to 30 seconds, and at once when any run settles. The
sweep pages by tenant. A member's queued run without an enablement starts
as the member is now, narrowed to what the enrolling identity held; a
project principal's, as the principal it enrolled as. Kind-derived delivery
keys are scoped by the enablement they start, and interactive fires carry
none.

Considered: a promotion inside the settling transaction (it cannot admit,
which is IO, and every terminal path would need it); a Postgres trigger
(hides scheduling in SQL and still cannot admit); keeping trigger delivery
ids as correlation keys with a second "concurrency key" column (two keys on
one run that both mean "unique while live").

## Consequences

Per subject serialization is one line of workflow code, and recipes keep
their state where the chat is. Queued runs show in run lists with status
`queued`. A redelivered webhook, schedule occurrence or event now returns
its original run even after it finished. A started queued run waits for
admission like any other; its start can lag a settle by up to the
maintenance interval when no job settles on that replica. Hosts that
derived keys in their trigger kinds rename `correlationKey` to
`deliveryKey`.
