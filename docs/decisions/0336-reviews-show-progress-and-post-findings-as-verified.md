# 0336: Reviews show progress at once and post findings as they are verified

- **Status:** Accepted (amends 0259, 0323, 0325)
- **Date:** 2026-11-18

## Context

The review recipe posted nothing until a review turn ended: `postReviews` read
the turn's one `review` result and only then posted the review, its inline
comments and the "Work review" check run. A review on a new machine can spend
over 10 minutes preparing before the agent starts, and a production pull
request reviewer took 30 minutes on a small change, which was merged before
any finding appeared. That reviewer posts an in progress check and each
verified finding at once. Results are recorded mid-turn and fire
`session.result-recorded` (ADR 0323), one workflow owns every GitHub write
(ADR 0259), and runs queue per key (ADR 0325). But a key queued at most 100
runs, one per event, and a chat kept at most 1,000 results while a review chat
lives as long as its pull request.

## Decision

**Queued runs coalesce.** A workflow may declare `concurrency.coalesce` (with
`queue`): one to four paths whose values say what a run is for. A run that
would queue while a queued run of its key, owner and enablement has the same
values joins it, under the key's lock and before the queue's bound, keeping
its place (migration 091). Coalesce only runs that read what is new when they
start. Without it a burst of findings filled the poster's queue and the turn's
settled event, refused, never published its verdict.

**One writer hears more.** `postReviews` also runs on the review chat's
`session.turn-changed` statuses `queued`, `preparing`, `running` and
`cancelled`, and on `session.result-recorded` for `finding`, coalescing on the
event's kind, turn and status. The queue keeps two publications from writing
at once, not the order events happened in (replicas, retries and joining
reorder them), so ordering is not what protects the verdict. These guards do:
progress never writes on a commit with a verdict, rewrites a run only after
reading it by id and never once completed, a status arriving after its turn
stopped working changes nothing, every write checks GitHub's head, and
findings are found by their markers.

**A review shows it started.** For a working turn the poster creates, on
GitHub's head of the open pull request, an `in_progress` run with external id
`work-review:<number>:progress:<turn>`, unless the commit has a verdict; a run
an earlier turn left cancelled does not stop a new one. Its title is *Waiting
to start*, *Preparing the workspace* (the turn is `preparing`) or *Reviewing*,
from the chat's turn state. The verdict completes that run; this pull
request's own run always ends, with the commit's verdict when another pull
request on the same head holds a stronger one. The chat's `review.progress`
(`{ commit, id }`) only says where to look: a newer head cancels the App's own
run there that carries this pull request's progress prefix. A closed pull
request, or a queued turn cancelled with no other at work, cancels the head's.

**Findings post as they are verified.** The reviewer submits each verified
finding as a `finding` result (`id`, `path`, `line`, optional `startLine` and
`side`, `severity`, `title`, `body`), then a `review` that does not repeat
them. A finding's publication decides from Work's record alone, so one with
nothing to post calls GitHub not at all: of the turn's first 30 distinct
findings, those first submitted since its event, while `current`. It posts
them in one review whose body is their markers
(`<!-- work-review:<commit>:finding:<id> -->`), each comment ending with its
own, on lines the diff has, while the commit holds fewer than 30 so posted.
The turn's review posts what is left of its first 30, as last submitted
(stale, outside the diff, corrected), so nothing depends on the agent
remembering ids across a hand-off. A turn of 100 findings or more cannot tell
its first ones from the newest it reads and posts none. Finding-only reviews
never count as a review that stands for the commit.

**A newer turn speaks for the head.** A publication with no usable review
marks a commit only while no newer turn of the chat works.

**Results are bounded per turn, and their reads per chat.** A turn records at
most 1,000 results of at most 256 KiB. A chat keeps every result over its
life, so nothing bounds its result storage but its turns; reads are bounded:
`results` returns at most 100, and the latest of each name (hand-offs, a
parent's list and wait) is looked for among a chat's newest 1,000 results,
leaving out a name only older ones carry.

**Result patterns match in linear time.** Applying every pattern (Ajv keyed
them by `toString()`, so one applied to all) put project regexes on
agent-submitted values in the server's process. They now run with RE2's
semantics on re2js, refusing at load what RE2 cannot run, and one check of a
value spends at most 20 million steps of pattern work (ADR 0323 corrected).

**Smaller.** `SessionSnapshot` names the chat's `environment`, which a chat
waiting for its machine has before a placement. Report text loses HTML comment
delimiters until none is left.

Considered: one workflow per kind of write (separate queues race on the same
finding); a typed action for single review comments (GitHub stores them as
reviews anyway); trusting the chat's record for what was posted.

## Consequences

An author sees the review start within a minute and findings as they are
verified, a few GitHub calls per publication, and no flood of findings can
lose the verdict. The `review` result has no `comments` or `findings`.
Coalescing is available to any queued workflow that reads current state.
