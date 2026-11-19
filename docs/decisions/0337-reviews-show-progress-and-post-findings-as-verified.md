# 0337: Reviews show progress at once and post findings as they are verified

- **Status:** Accepted (amends 0259, 0323, 0325)
- **Date:** 2026-11-18

## Context

The review recipe posted nothing until a review turn ended. A review on a new
machine can spend over 10 minutes preparing, and a production pull request
reviewer took 30 minutes on a small change, which merged before any finding
appeared. Results are recorded mid-turn and fire `session.result-recorded`
(ADR 0323), one workflow owns every GitHub write (ADR 0259), and runs queue
per key (ADR 0325), but a key queued at most 100 runs, one per event, so a
burst of findings could fill the queue and lose the turn's verdict.

## Decision

**Queued runs coalesce.** A workflow may declare `concurrency.coalesce`
(with `queue`): one to four paths whose values say what a run is for. An
event the host delivers with no one waiting for its outcome joins a queued
run of its key with exactly the same values, program, session artifact,
Environment, owner, scopes and enablement (hashed together), under the
key's lock and before the queue's bound (migration 093). Calls, synchronous
fires and setup runs report their own run and never join. A joined
delivery's redelivery returns the run it joined; cancelling that run ends
every delivery that joined it.

**One writer hears more, and decides from now.** `postReviews` also runs on
the review chat's `queued`, `preparing`, `running` and `cancelled` turns and
on each `finding` result, coalescing on kind, turn and status. The queue
does not keep event order, so every publication decides from the turn's
state (`inspect` names the turn at work and the chat's `queued` turns) and
from GitHub: progress never writes on a commit with a verdict, every write
checks GitHub's head, findings are found by their markers. Nothing the chat
records decides what to post.

**A review shows it started.** A turn at work or waiting gets an
`in_progress` "Work review" run on GitHub's head, stamped
`work-review:<number>:progress:<event>`. Every terminal transition ends
every run of the App's still in progress with this pull request's prefix
on that head, through one typed action, `complete_check_runs`: the verdict,
a close or a cancelled turn ("Not reviewed"), and a new run, which ends
those on the pull request's other commits ("Superseded").

**Findings post as they are verified.** The reviewer submits each verified
finding as a `finding` result; its `review` no longer carries them. A
publication posts the turn's first 30 distinct findings that are still
current and on the diff, in one review whose body is their markers, while
the commit holds fewer than 30. The turn's review posts what is left, and
it and the check say exactly how many were not posted.

**Results are bounded per turn.** A turn makes at most 100 submissions,
refused ones included, of at most 256 KiB each, so one read holds a turn's
findings; reads return at most 100, and the latest of each name is looked
for among a chat's newest 1,000. A restarted attempt is handed every result
its turn submitted, in short.

**Result patterns run in linear time** on RE2 with ECMAScript's meaning,
within compile and matching bounds (ADR 0323 states them).

Considered: one workflow per kind of write (separate queues race on the same
finding); a chat record of where the progress run is and which findings
were decided (the reviewer can write it, and GitHub already says both).

## Consequences

An author sees the review start within a minute and findings as they are
verified, and no flood of findings can lose the verdict. A finding's
publication reads the pull request even when nothing new came. A run made a
moment before the verdict's list can stay in progress until the next push.
Coalescing is available to any queued workflow that reads current state.
The recipe's SKILL.md describes each step.
