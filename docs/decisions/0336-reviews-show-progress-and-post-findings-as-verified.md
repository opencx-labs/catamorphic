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
verified finding at once. The primitives were there: results are recorded
mid-turn and each fires `session.result-recorded` (ADR 0323), one workflow
owns every GitHub write (ADR 0259), and runs queue per key (ADR 0325). One
limit was not: a chat kept at most 1,000 results, and a review chat lives as
long as its pull request.

## Decision

**One writer hears more.** `postReviews` also runs on the review chat's
`session.turn-changed` statuses `queued`, `preparing`, `running` and
`cancelled`, and on `session.result-recorded` for `finding`. Every event
carries `payload.session.key`, so they share its queue: each run starts after
the one before it, in event order, and a progress write can never overtake
or race the final one.

**A review shows it started.** On a queued, preparing or running turn the
poster reads GitHub's head of the open pull request. If the App has no "Work
review" run on that commit, it creates one `in_progress`, external id
`work-review:<number>:progress`. Its title follows the chat's working turn,
which existing turn state tells cheaply: *Waiting to start* (no working turn
on that head yet), *Preparing the workspace* (the turn is `preparing`: a
machine, setup), *Reviewing* (the turn runs on that commit). A later status
rewrites only the text, after reading the run by id, and never a completed
run. The final publication completes that run with the verdict (an update,
not a new run). The chat records `review.progress` (`{ commit, id }`); a
progress event for a newer head reads that commit's runs and cancels the
App's in progress run that carries this pull request's progress id. The
record is the reviewer's to write too, so it only says where to look: GitHub
and the id decide, and the head is never cancelled. A turn that settles or is
cancelled on a closed pull request cancels the head's in progress run.

**Findings post as they are verified.** The reviewer submits each verified
finding as its own `finding` result (`id`, `path`, `line`, optional
`startLine` and `side`, `severity`, `title`, `body`), then the final `review`,
whose `findings` lists the ids it stands behind; its `comments` are gone. On
each `finding` the poster posts it as a one comment review whose body is the
finding's marker, `<!-- work-review:<commit>:finding:<id> -->`, when the
result is `current`, the commit its turn began on is GitHub's head of the
open pull request, its lines are in the diff, and none of the App's reviews
on the pull request carries the marker yet. A commit takes at most 30 such
reviews. The final publication posts the referenced findings of its turn
that no review carries yet (inline where they fit, in its body otherwise)
and lists their markers in its body. So a finding posts once per head and id
across retried runs, resubmissions after a restart or hand-off, and the
final review; GitHub's lists can lag a write by a moment, as ADR 0325 says.
Reviews made of findings never count as one that already stands for the
commit. A finding a comment made stale waits for the final review, which
still posts it if it refers to it: a question does not withdraw a finding.

**A newer turn speaks for the head.** A publication with no usable review
marks a commit only while no newer turn of the chat works; otherwise that
turn's publication does. So a turn of an earlier head, settling after the
workspace moved, cannot complete the new head's check.

**Results are bounded per turn.** A turn records at most 1,000 results, each
at most 256 KiB, instead of a chat recording 1,000. A chat's results grow with
its turns like the rest of its log, which its life bounds: closing or
archiving it. The poster reads a turn's newest 100 findings.

**The workflow snapshot names the chat's Environment.** `SessionSnapshot`
gains `environment` (recorded before a machine is placed), which inspect
already returned, so the poster knows a review chat still waiting for its
machine.

Considered: one workflow per kind of write, which ADR 0325's per workflow
queue does not order against each other; a new typed action for a single
review comment, which GitHub stores as a review anyway; trusting the chat's
record for which runs to cancel or which findings were posted.

## Consequences

An author sees the review start within a minute and each finding as it is
verified. A review chat runs the poster for every status and finding, a few
GitHub calls each. Findings are a second result to keep in step with
`review-report.ts`. The `review` result's `comments` field is removed.
