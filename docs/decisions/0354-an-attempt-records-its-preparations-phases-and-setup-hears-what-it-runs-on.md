# 0354 — An attempt records its preparation's phases, and a setup command hears what it runs on

- **Status:** Proposed
- **Date:** 2026-11-26
- **Amends:** 0198, 0208, 0258, 0324, 0333
- **Amended by:** [0355](0355-hooks-are-triggers-a-waited-event-and-setup-asks-before-it-replaces.md): `setup.timeoutMinutes` times the wait for the runs of the workspace's setup event, whose reason is the same one

## Context

A turn that is `preparing` said nothing more. Where its minutes went (waiting
for a machine, making the sandbox, the checkout, the installs) was visible only
as OpenTelemetry spans, which belong to the host's operators: a project
measuring its pull request reviews had to keep a ledger of its own. A setup
command also could not tell which commit it ran on or why, so it reinstalled
everything on every push.

## Decision

**An attempt keeps its phases.** `agent_turn_attempts.phases` is an ordered
list of `{ phase, startedAt, endedAt }`, written when each phase starts and
again when it ends, so a stuck preparation shows where it is; a phase that
runs has no end yet. The names are a contract: `machine.wait`,
`workspace.wait` (another chat's turn makes or sets up the workspace they
share, ADR 0322), `sandbox.create`, `sandbox.start`, `workspace.checkout` (the
base, ADR 0353), `workspace.restore` (the chat's saved work), `setup.environment`,
`setup.workflow`, `setup.personal`, `harness.start` (until the runner's hello)
and `harness.first-output` (until the agent's first item, or its end). Each is
recorded where it applies; time between them is Work's own preparation. A
phase the attempt left running reads as ended when the attempt ended; one a
stopped holder left running ends when the attempt is prepared again.

**They are read with the attempt**, by whoever may read the chat: `read` with
`include: ["attempts"]` in a workflow, `session_read` over MCP, and
`GET …/turns/:turnId/attempts`. Spans stay as they are.

**The wait for a machine is carried to the attempt.** It is the chat's and
ends before any attempt exists, so the Allocation that ends it keeps since
when (`execution_allocations.waited_since`, set in the transaction that
deletes the placement wait; a wait nobody tried for two minutes was no wait).
The first attempt prepared on that Allocation takes it, once.

**Each part of a setup runs as a script of its own**, so each is timed, and is
bounded by the setup's timeout as the claim wait already assumed (ADR 0324).

**A setup command hears what it runs on.** Its script exports `WORK_BASE`
(the commit the workspace stands on), `WORK_PREVIOUS_BASE` (the commit this
sandbox's last setup ran on; unset when it has not set up) and
`WORK_SETUP_REASON` (`created`, `rebuilt`, `base-moved` or `changed`: the
reason the setup workflow is given, from one function). The Environment's
command reads them on both paths, its own network included (ADR 0257), and so
does the member's own setup, in a sandbox or a worktree.

Lost alternatives: a table of phases (they are read only with their attempt,
as its diagnostics are); events in the session log (it is mirrored and
replayed, and timings are one host's observation, like `progress_at`); reading
spans back (the host owns its exporters, and a project has none).

## Consequences

A workflow can report where a chat's time goes without a ledger, and a setup
can install only what a push changed. `sandbox.create` includes pulling or
building the Environment's image: a machine does both in one call, and telling
them apart needs the provider to report it. A shared subsession's own wait for
its workspace session's machine is not carried: the Allocation is not its own.
