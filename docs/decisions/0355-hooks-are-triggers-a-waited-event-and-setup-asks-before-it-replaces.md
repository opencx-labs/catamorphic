# 0355 — Hooks are triggers, an event can be waited for, and setup asks before it replaces

- **Status:** Proposed
- **Date:** 2026-11-28
- **Amends:** 0257, 0324, 0352, 0354 (and 0039 in spirit)

## Context

A pull request reviewer keeps one chat per pull request, in an Environment
whose setup has a network of its own (ADR 0257) and a setup workflow (ADR
0324). Every push replaced the chat's sandbox, checked the repository out
again and reinstalled, even when no lockfile changed: Work decided that setup
was due and replaced the sandbox before any project code was asked. And
`setup.workflow` took a workflow by name from an Environment's configuration,
a second home for subscriptions that ADR 0039 puts in workflow source and ADR
0352 refused for approvals.

## Decision

**A hook is a trigger kind, or host code.** Where project code should run at a
point in Work's own lifecycle, Work records a session event and workflows bind
it in their source, with config and `where`, consented with their enablement.
An Environment never names a workflow. `setup.workflow` is removed: a manifest
that names it is invalid and says to bind the trigger. The deploy workflow
(ADR 0331) is the one name left in a manifest, unchanged here.

**An event can be waited for.** Its emitter asks who listens before it
records anything: an active project automation bound to the kind whose config
and `where` match the event as a dispatch matches them, and which may change
the chat as the dispatcher requires (a member's own automation hears the event
and never counts). With none, nothing is recorded as waited and nothing waits.
Otherwise the event is recorded (`project_events.waited`), the dispatcher is
hinted, and the emitter waits until every listener's delivery was made and
every run it started ended, or its deadline passes. The dispatcher stamps
each run with the event it delivers (`workflow_runs.event_id`, which no
caller's input or delivery key reaches); a waited event's run is its own,
never joined to a queued one (ADR 0337). Nothing comes back through a run's
return value: a workflow decides by calling operations. Several listeners all
run, and the wait ends when all have ended.

**`session.workspace-setup`.** Recorded where the setup workflow ran, after
the Environment's `setup.command`, with the chat's snapshot and, in `detail`,
`reason` (`created`, `rebuilt`, `base-moved`, `changed`), `environment`,
`workspace { ref, commit }`, `previous { commit } | null` (the base this
sandbox last set up on) and `sandbox: "new" | "kept"`. The turn waits for its
runs within `setup.timeoutMinutes`. A failed, canceled or unstarted run, or
the deadline (its runs are then canceled), is a failed setup as before: the
agent is told and it is asked again next turn. Only runs this event started
for a project automation may `exec` with `in: "setup"`, while it is waited for;
the stamp replaces `setup_session_id` and `setup_build`. A chat in a folder
on a person's computer records none, as no setup workflow ran there.

**Setup asks before it replaces.** With nobody listening, nothing changes.
Where somebody listens and this preparation made the sandbox, or it never set
up, the command runs first (on its own network when declared), then the
event. Where somebody listens for a sandbox the chat already set up (the base
moved, the command changed), Work replaces nothing and runs nothing by
itself: the checkout moves to the base in place, as Git sends what it lacks
and ignored files stay, the chat's credentials are taken out (ADR 0324), and
the event says `sandbox: "kept"`. If a run then asks for the setup's network
(`exec` with `in: "setup"`) and the setup has one, the sandbox is replaced at
that point by the rule of ADR 0257: a new one in the same Allocation, its
base checked out, `setup.command` run in it, then the command. If none asks,
the sandbox and what it installed stay, and setup is recorded done for the
base. Not while another session's turn runs in the workspace: it is replaced
as before.

**`changedPaths`.** `sessions.changedPaths({ sessionId, from, to })` answers
`{ paths, truncated, complete }` from the session's copy, at most 2000 paths;
`complete: false` when the copy lacks a commit.

Considered: a `keep` switch on the Environment (the decision depends on the
push, which only code can read); a workflow's return value as the decision (a
second firing model); asking before the base is fetched (the workflow reads
the commits); widening a kept sandbox (ADR 0257's leak).

## Consequences

A push that changes no lockfile costs a fetch and a workflow run. A push no
longer reruns `setup.command` by itself where a workflow listens: the workflow
asks for the setup's network to have it run. What a run does in a kept sandbox
before asking is lost with it, so network work goes first. A kept sandbox
reviews a later revision where an earlier one already ran code: that is the
workflow's choice. The executor's network lock is a claim in Postgres (ADR
0193), not a transaction: a worker's operations travel through the database,
which a single-connection one could not answer while the lock was held.
Later hooks (a workspace going idle, a result being submitted) reuse the
waited event, and the deploy workflow could become one.
