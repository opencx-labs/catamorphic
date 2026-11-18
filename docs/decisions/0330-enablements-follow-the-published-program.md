# 0330 — Enablements follow the published program

- **Status:** Accepted (amends 0068, 0158, 0170; builds on 0040, 0193)
- **Date:** 2026-11-17

## Context

A workflow enablement is pinned to one commit (`workflow_enablements.commit_sha`).
A new published revision only marks it `update_available`; someone must preview
it again and call `updateDeployment`. A team that deploys by merging to `main`
(a code-host project syncs `main` every minute, ADR 0170) therefore keeps
running old workflow code until a person or a bespoke script catches up, while
the rest of the program (agent definitions, skills) already reads the new
`main`. The code-host sync path did not even mark enablements: only the trigger
scan noticed a new commit.

## Decision

**An enablement can follow the published program. Each newly published
revision moves following enablements to it when the workflow builds and parses
there and the authority the owner consented to is unchanged.**

- `follow` is a field on every enablement, set when it is created and changed
  later through `POST …/workflow-enablements/:id/follow` (and the server SDK).
  The name matches what it does: the enablement already names its branch
  (`remoteBranch`), and `follow` says it tracks that branch's published head.
  It defaults to `true` for a project automation of `main`: whoever may
  publish to `main` already decides what the project's own workflows do, and
  consent gates authority, not code (ADR 0158). It defaults to `false` for a
  member's own automation, which runs with that member's connections: code
  someone else merged should not start using them before the member sees it,
  so only that member may turn following on (anyone who manages it may turn
  it off). Temporary enablements, session-retained
  source and other branches never follow. Existing lasting project
  automations of `main` follow after the migration; members' stay pinned.
- **Published revisions are recorded** only by the paths that move the
  published ref (a local deploy, a server draft deploy, a code-host sync that
  receives commits), under a lock on the project row, and only when the
  commit is what `main` points to at that moment; a slow or stale caller can
  never make an older commit the newest revision. A newer revision
  supersedes older ones still `pending`. Creating an enablement or pointing
  it at a commit stamps the latest recorded revision on it, so no older one
  moves it, and a follower never moves to a commit older than one a later
  revision carries.
- **Moving is the existing update.** For each follower Work previews the
  enablement at the revision as its owner (the member, or for a project
  automation the member who consented, resolved again through memberships),
  which builds the artifact and registers trigger definitions exactly as
  enabling does. If the preview's authority digest equals the one stored
  when the owner consented, the enablement takes the new commit, artifact
  and triggers in one transaction (`followed` event). A trigger unchanged
  at the new commit keeps its activation (its id, creation time and
  receipts), so an event it received before the move and has not delivered
  yet is delivered after it, and a schedule keeps its clock; a new trigger
  starts from the move. The authority digest is the consent digest without
  the artifact digest plus what starts the workflow (each trigger's kind,
  configuration and filters, and whether workflows may record its project
  kind, ADR 0326) and the run secret names the project declares, so a
  merge cannot add a public webhook, a broader filter, a frequent schedule
  or a new secret without consent.
  Otherwise it stays, is marked `update_available`, and its owner (for a
  project automation, everyone who manages project automations) is notified
  through user notifications. Only a deterministic failure of that workflow at
  that revision skips it (its source does not parse, it is gone, its triggers
  do not register): that is reported the same way, and it follows again at
  the next good revision. Any other failure (the database, the network,
  capacity, a timeout, a machine or connection unavailable for now) never
  skips: the revision stays applying for that
  enablement and is tried again with backoff (15 seconds, doubling, at most
  15 minutes), until a newer revision takes the enablement over. Runs in
  flight keep the commit they started on (ADR 0040).
- **Order and replicas.** Revisions advance in publication order, one step at a
  time per project, from the event dispatch pass every host already runs. A
  step holds the replica claim `published-revisions:<projectId>` (ADR 0193),
  ready projects before ones waiting to try again;
  status changes are compare-and-set; a partial unique index allows one
  `deploying` or `applying` revision per project; and each enablement records
  the sequence it last followed and never moves to an earlier one. Two
  replicas can therefore neither move one enablement twice nor out of order.

Alternatives: an external watcher that previews and updates (what the opencx
watcher does) leaves every team rewriting the same loop; following without a
consent check would let a merge widen a workflow's authority silently.

## Consequences

Merging to `main` is deploying: workflows reach the new code within a dispatch
pass after the sync sees it. A merge that needs new consent waits for a person,
loudly. ADR 0331 adds the project's deploy workflow before followers move.
Follow-ups: a desktop toggle for `follow` and a view of published revisions
(the API lists them today).
