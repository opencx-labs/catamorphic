# 0331 — A project deploy workflow, and host project hooks that return secrets

- **Status:** Accepted (amends 0046; builds on 0206, 0330)
- **Date:** 2026-11-17

## Context

With enablements following `main` (ADR 0330), a project workflow that owns a
database has no moment to migrate it before new code goes live, and runs pinned
to the previous commit keep running meanwhile. Hosts that give each project its
own infrastructure (a schema, a bucket) also have no way to hand the project
the credentials they minted, and a failed cleanup on delete simply aborted the
delete (ADR 0046).

## Decision

**A project may name a deploy workflow that Work runs once per published
revision before followers move; host project hooks may return secrets on
create and are retried on delete until they report done.**

- **Deploy workflow.** `.work/project.json` (the manifest, ADR 0169) may say
  `"deploy": { "workflow": "<exported workflow name>" }`, read at each
  revision. Before following enablements move to that revision, Work runs the
  workflow at that revision with input `{ commit, previousCommit }`
  (`previousCommit` is the last revision that went live, else the deploy
  enablement's commit) and waits for it to settle. It runs through the
  workflow's own **project automation**: the one active project-owned
  enablement of that workflow, so its connections and secrets are the ones
  consented to; the run uses that enablement's authority at the new commit
  only when the authority is unchanged there. None, several, or changed
  authority fail the revision. The deploy enablement itself follows like any
  other once the revision applies.
- **Failure stops the move.** A failed, canceled, or unstartable deploy leaves
  every enablement where it was, marks the revision `failed` with the reason,
  and notifies the people who manage project automations. The next published
  revision tries again with its own deploy run. The project's latest
  revision, when it failed, can also be tried again on request
  (`POST …/published-revisions/retry`, `client.publishedRevisions.retry`;
  `automations:write`), and is tried again once by itself when its deploy
  workflow's project automation is consented to again (created, updated or
  turned back on): its deploy runs again at that revision and, on success,
  followers move. At most one deploy runs per
  project, in publication order, enforced by the revision state machine of
  ADR 0330 (the partial unique index and the per-project claim), not by a run
  correlation key. Work does not know what the workflow does: migrations with
  any tool, or nothing.
- **Host project hooks.** `projectHooks` (`createCatamorphic`, plugins, and
  now `WorkServerHooks.projectHooks`): `onProjectCreated` may return
  `{ secrets: Record<NAME, string> }`; Work stores each as the project's
  shared secret value (ADR 0206 store, vault-sealed, names follow the
  Environment secret rule, set by `host`), without interpreting it. A workflow
  reads one once it declares the name with `defineSecrets`. `onProjectDeleted`
  no longer blocks the delete: the project is deleted, and a hook that throws
  or returns `{ done: false }` is recorded in `project_cleanups` and retried
  with backoff from the dispatch pass until it returns done, like a machine
  provisioner's destroy.

## Consequences

Expand then contract is the migration discipline: a deploy adds what the new
code needs while runs on the previous commit keep working, and a later
revision removes what nothing uses. A host can give every project its own
Postgres schema and role and return `DATABASE_URL`; that is an example in
`INTEGRATION.md`, not a feature. `ProjectDeprovisioningError` is gone. Item 4's
per-key run queue can later replace the revision state machine's own
serialization of deploy runs.
