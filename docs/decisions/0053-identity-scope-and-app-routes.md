# 0053 — Identity scope: one artifact vocabulary, structural narrowing, synchronous calls

- **Status:** Accepted
- **Date:** 2026-08-17
- **Builds on:** 0002 (embed-only), 0036 (app authorization), 0037 (guest
  runtime and mount), 0039 (sync trigger firing), 0040 (one workflow model)
- **Supersedes in part:** 0036 (audience identity headers), 0037 (mount
  attaches audience headers; invoke = queued run + polling)

## Context

The first real external-user use case arrived: a company runs its brain as
a Catamorphic project, builds per-customer apps in it, and wants customers
to open those apps inside the company's own product, behind the company's
own auth — and, later, to reach shared documents and individual workflows
the same way.

Three things stood in the way:

1. **Identity was header-only, and narrowing was a client claim.** The
   HTTP plugin read `X-Catamorphic-Tenant-Id` / `X-External-User-Id`, and
   `AppMount` narrowed itself by attaching `X-Catamorphic-App-Id` /
   `X-Catamorphic-App-Version-Id` from the view-state response (ADR 0036).
   Nothing forced a *class* of user onto an audience: a customer who called
   the API without the narrowing headers had full builder access. The
   safety of the design rested on header discipline in the client.
2. **`appAudience` was the special case of something general.** It named
   one app version by id. Documents, single workflows (per-customer MCP
   tools, ADR 0042), and future artifacts would each have needed their own
   audience field and enforcement path.
3. **Every app call was a queued run plus polling** (ADR 0037's stated
   cost). Fine for actions, wrong for a project tracker whose every list
   and filter is a workflow call. Sync execution already existed for
   trigger firing (ADR 0039) but was not a general calling mode.

Greenfield (no production users) let us remove rather than add.

## Decision

**1. `Identity.scope`: one vocabulary for what a caller may touch.**

```ts
interface Identity {
  tenantId: string;
  externalUserId: string;
  scope?: readonly ArtifactRef[];   // absent = full (builder); present = viewer
}
type ArtifactRef =
  | { kind: "app"; projectId; name; channel?: "published" | "dev" }
  | { kind: "workflow"; projectId; name }
  | { kind: "document"; projectId; path };   // reserved for publications
```

Refs name artifacts by `(projectId, name)`, never by row id: that is what a
host's entitlement table naturally keys on, it is stable across republishes,
and it lets core resolve "the currently active published version" at check
time — a retired version cannot be named, so its old (possibly wider) set can
never be reached. The `dev` channel is a resolution hint (the builder's own
latest build) and not part of the artifact's identity; for anyone but the
builder it resolves to nothing.

`appAudience` is deleted outright. Enforcement keeps ADR 0036's shape,
re-keyed on scope:

- `assertFullIdentity` (was `assertProjectSurface`) rejects any scoped
  identity — including an empty scope — from files, deploys, secrets, agent
  sessions, app builds, run controls and drill-downs.
- `resolveScope` / `assertScopeAllowsWorkflow` (were `resolveAppAudience` /
  `assertWorkflowAllowed`) expand a scope for a project: app refs → the
  active version's frozen set (∩ the tenant workflow allowlist, and subject
  to the `apps_enabled` kill switch), workflow refs → themselves, document
  refs → nothing yet. Trigger, sync call, run get/list, the guest document,
  view-state and app storage all go through it. Denials stay one uniform
  `AccessDeniedError` (HTTP 403).

Scope is the **output** of host policy, never its input. Which users are
builders and which artifacts each viewer gets — a table, a role, a workflow
that resolves roles — is the host's business; catamorphic only enforces the
result. Roles, publications and an authorize seam are deliberately parked;
they will speak this vocabulary when they land (the `document` kind is
reserved so publications never touch `Identity` again).

**2. The HTTP plugin has exactly one identity mechanism: a required host
resolver.**

```ts
app.register(catamorphicPlugin, {
  core, prefix: "/api",
  identity: async (req) => (await verifySession(req)) ? { tenantId, externalUserId, scope? } : null,
});
```

It runs on every request in an `onRequest` hook (including iframe
navigations to served app documents, which carry the host's session
cookie); `null` is 401. Header-based identity is no longer a default but a
stock resolver, `identityFromHeaders()`, for hosts whose auth terminates in
front of the plugin — and the desktop passes `() => DESKTOP_IDENTITY`,
which removed its header-defaulting hook. "There is no default identity" is
now true structurally: the host always writes the line that says who is
calling.

**3. Narrowing is structural: app-originated calls have their own routes.**

```
GET  /api/projects/:id/apps/:name/view-state | guest | (PUT) storage
POST /api/projects/:id/apps/:name/calls/:workflow      → sync outcome
POST /api/projects/:id/apps/:name/runs/:workflow       → 201 Run (async)
GET  /api/projects/:id/apps/:name/runs/:runId
```

Each of these applies `narrowIdentity(caller, { kind: "app", projectId,
name })` before touching core: a full identity is confined to the app (ADR
0036's defence-in-depth against the untrusted bundle, kept), a scoped
identity that covers the app is narrowed to it, and one that does not gets
an empty scope. Narrowing can only shrink, so it is always safe. The
`X-Catamorphic-App-*` headers are gone; `AppMount` carries no audience
claim; there is nothing to validate and nothing to forge. The apps MCP
endpoint (ADR 0042) narrows to the owning app the same way.

**4. Synchronous execution is a calling mode.** `runs.call({ identity,
projectId, workflowName, input, budgetMs? })` triggers a run exactly like
`triggerProduction` and drives its queue jobs inline (the ADR 0039 driver,
moved into `RunsService`) until it settles or would wait, answering
`{ completed, output } | { failed, error } | { suspended, runId,
suspendedOn }`. Same durable run record, same immutable deployed commit; a
suspended run is finished by the polling workers. Exposed as
`scoped.runs.call` (SDK), `POST /projects/:id/workflows/:name/calls`
(HTTP), the app `calls` route, and the apps MCP tool call. `AppMount`'s
`invoke` uses it and polls only on `suspended`. One workflow model (ADR
0040) is untouched: there is no "fast" or "read-only" workflow kind.

## Consequences

- A host gets customer-facing apps behind its own auth with one resolver
  and one entitlement table; the embed skill carries the recipe verbatim
  and the plugin tests play the four cases (builder, granted viewer,
  ungranted viewer, signed-out).
- Fewer concepts than before: one identity mechanism, no narrowing headers,
  one enforcement vocabulary for apps, workflows and (soon) documents.
- A builder inside an app sees exactly what a viewer would; the dev channel
  resolves to their own latest build only.
- Chatty app UIs settle in one round trip when their workflows do not
  suspend; the per-call cost is now a run record and a warm runtime
  invocation, not queue pickup latency. If that is still too slow the thing
  to tune is the run ledger, not authorization.
- Public / anonymous access, publications (documents with audiences),
  roles, and a host authorize seam are explicitly out of scope here and
  will build on `scope`.
