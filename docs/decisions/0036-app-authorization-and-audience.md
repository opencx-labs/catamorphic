# 0036 — App authorization: contract surface, frozen sets, audience identities

- **Status:** Accepted
- **Date:** 2026-07-27
- **Expands:** 0001, 0002, 0028, 0032, 0035

## Context

Apps are used by *any host user*, not just project builders — a viewer who
cannot edit the project must run an app, and the app's bundle executes in that
viewer's browser. Untrusted code, untrusted user, and until now no membership
model at all: `requireProject` checked only `tenant_id`, so any tenant user
could invoke any workflow and read any file.

A common approach is a multi-stage pipeline (static analysis at submit,
human consent at publish, runtime brokering) — but deriving the allowed call
set with a regex is unsound in both directions (false positives and false
negatives), so it can't be the authorization boundary on its own.

## Decision

The callable set for an app is the intersection of three gates, each owned by
a different party:

**1. Author intent — `workflows/src/app-api.ts`.** A workflow is app-callable
iff it is exported from the contract surface. The parser resolves each entry
through ts-morph *bindings* (imports, renames, shorthand — never text
matching), and resolution fails closed: one unresolvable entry rejects the
whole surface, because a partially resolved surface would silently ship a
wrong authorization set. This file doubles as the type surface apps compile
against, so types and permissions cannot disagree (ADR 0032).

**2. The build — frozen per version.** `AppsService.build` parses the same
tree the bundle compiled from and freezes the resolved workflow names into
`app_versions.allowed_workflows`. It is a cache of something re-derivable from
the commit, not a registry (ADR 0001 holds). A version with no valid contract
surface fails its build.

**3. Host policy — `tenant_app_policies`.** Mirrors ADR 0028: host-written via
SDK, not HTTP-reachable, absent row = defaults. `apps_enabled` kill switch,
`max_apps_per_project`, `max_bundle_bytes` (min-wins with the install cap),
`allowed_network_origins` (iframe CSP, default deny), and `workflow_allowlist`
— which *intersects* with the frozen set and can therefore only narrow it.

**Audience identities.** `Identity` gains optional
`appAudience { appId, appVersionId }`. The HTTP layer populates it from
`X-Catamorphic-App-Id` / `X-Catamorphic-App-Version-Id`; the host must set
these on every app-originated request. The headers are a *narrowing* claim: a
guest forging them can only reduce its own access, and a half-formed or
malformed pair is a 400.

**Enforcement lives in core services, not routes** — `server-sdk` hosts bypass
Fastify entirely (ADR 0002). Two primitives:

- `assertProjectSurface` rejects audience identities from every project
  surface (files, deploys, secrets, agent sessions, app builds, run controls
  like cancel/pause/resume/signals, batch drill-downs). Applied at service
  chokepoints (`getRow`, `requireProject`) so new methods inherit the gate.
- `assertWorkflowAllowed` gates run triggering and run polling. The referenced
  version must be the currently *active, ready, published* version of the
  claimed app in the claimed project and tenant — a retired version id is a
  denial, never its old (possibly wider) set. Audience identities may trigger
  runs *(wording updated by [0040](0040-one-workflow-model.md): test runs are
  removed, so the original production-only clause covers every run — all runs
  execute a deployed commit)*.

Every denial is one uniform `AppAccessDeniedError` (HTTP 403). The caller is
an untrusted bundle; detailed denials would enumerate the project for it.

The one read an audience identity may perform is `viewState`, which returns
decision-as-data (`not_found | not_published | ready`) rather than errors —
each state gets host copy, and a new state is a client compile error.

## Consequences

A viewer can load an active app and invoke exactly its frozen workflow set —
nothing else in the project, with negative tests asserting each boundary
(forged ids, cross-tenant claims, retired versions, allowlist intersection,
kill switch).

The audience axis is additive: hosts that never send the headers see no
behavior change. Full identities skip every check.

Rotating an app's permissions = shipping a new version and publishing it; the
old version's set dies with its `is_active` flag. Host-side session plumbing
(how a viewer's requests acquire the headers) is the host's responsibility, as
is rate-limiting app traffic (ADR 0028 budgets apply unchanged, since app runs
are ordinary queued runs).
