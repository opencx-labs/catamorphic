# ADR 0068: Local personal artifacts and explicit workflow enablement

- **Status:** Accepted
- **Date:** 2026-08-24
- **Supersedes in part:** 0065 and 0066's service-only unattended rule

## Context

Members need private workflows, skills, documents, apps, and agents while
working inside a project. Private code must not run remotely. Separately, a
reviewed project workflow must be able to run remotely for a member using that
member's connected accounts; requiring a service identity for all unattended
work prevents this personal automation model.

## Decision

Personal artifacts are plain files under
`.catamorphic/personal/<profile-id>/`. The desktop adds the root to the local
git exclude file. There is no nested repository, snapshot, sync, promotion
record, or remote discovery. Personal workflow execution is a best-effort
local development invocation using current files, not a durable Workflow Run.

Sharing is a normal coding-agent change: move the artifact to the canonical
project location, remove private assumptions, update dependencies and policy,
run project checks, and use the ordinary checkpoint and review flow. There is
no programmatic promotion API.

Introduce `WorkflowEnablement` for unattended execution. It binds an exact
committed deployment, Environment, member or service owner, exact connection
ids, narrowed capabilities, durable consent, triggers or schedules, and
lifecycle state. Every dispatch and broker call revalidates live authority.
Invalid authority suspends only that enablement and never falls back to another
principal.

Members may connect accounts on a remote server and enable a reviewed workflow
to run there for them. Multiple members may independently enable the same
workflow. New deployments mark existing enablements `update_available`; an
owner or administrator explicitly upgrades and reconsents.

## Consequences

Private artifacts remain simple and genuinely local. Every remote workflow is
committed and reviewable, while runtime identity stays explicit and
revocable. Canonical durable Runs continue to execute exact deployed commits.
Local personal schedules are best effort and require the desktop to be online;
remote schedules require an active committed workflow enablement.
