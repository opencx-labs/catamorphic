# 0326 — Workflows record project events

- **Status:** Accepted (amends 0156, 0158, 0171, 0177)
- **Date:** 2026-11-17

## Context

Project trigger kinds (ADR 0171) such as `github.pull_request` fire from
webhook ingress: a signed request to a public URL, stored once per delivery
id. A server without inbound webhooks, such as a company's private Work
server, has no way to feed them. The desktop polls GitHub for temporary
watchers (ADR 0177), but that is host code for one source, and the
pull request reviewer that needed it on a private server built its own poller
beside Work, with its own ledger, baseline and text comparisons. Polling is
policy (which API, how often, what counts as a change), so it belongs to
project code; what only Work can do is make a polled event fire triggers
exactly as a delivered one would.

## Decision

**A workflow records events of the project's own kinds.**
`host["catamorphic.events"].record({ events: [{ kind, id, payload,
occurredAt? }] })` is a returned host call like any other. One call records
up to 100 events, because a boundary returns one transition and a poll finds
several at once. Each event:

- names a project trigger kind of the run's revision whose chain resolves to
  the `webhook` host kind. Host kinds themselves (`session.*`, `schedule`,
  `directory.*`, `webhook`) and project kinds over any other host kind are
  refused: those events are facts only the host may state.
- if that webhook declares `verify`, belongs to a kind whose chain opts in
  with `recordable: true` in `defineTrigger`. A verified webhook (payments,
  deploys) promised that only signed requests fire it; recording would break
  that promise for every trigger without an `origin` filter, so it fails
  closed. The GitHub trigger library's `github.delivery` opts in.
- carries the payload the kind's events carry (for a webhook kind, `{ name,
  headers, query, contentType, body }`). The host builds the stored event,
  checks it with the root kind's payload schema and `matches`, and requires
  every `where` along the kind's chain to match: an event that its own kind
  would not deliver is refused, not silently dropped.
- is at most the host's webhook body limit (1 MiB by default) as JSON.
- is stored once per `(kind, id)`, as `recorded/<kind>/<id>`: a webhook
  delivery is stored as `<name>:<delivery id>`, and a webhook name never
  holds `/`, so the two never meet. Recording an id the project already has
  is a no-op that returns the existing event, so a retried poll is safe.

Recorded events dispatch exactly like ingressed ones: same table, same
dispatcher, same `where` filters, same downstream workflows.

**One provenance field.** Every webhook-kind event carries `payload.origin`:
`{ type: "request" }` for a request to the webhook URL (checked as the
binding's `verify` declares), `{ type: "host" }` for an event the host
fetched itself (the desktop's GitHub poller), and `{ type: "workflow",
workflowName, runId, enablementId? }` for a recorded one. It replaces
`hostVerified`. A trigger that must only accept signed deliveries says
`where: { payload: { origin: { type: "request" } } }`. The host sets
`origin`; a value in the recorded payload is overwritten.

**Causation stops loops.** A recorded event carries `payload.causation`: the
recording run's own causation followed by its enablement (ADR 0219). The
dispatcher already suppresses delivery to an enablement already in the chain,
so a workflow never re-triggers itself through its own events, directly or
through another workflow that records in turn.

**Authority.** Recording needs the new project permission `events:write`,
which the workflow declares (ADR 0158) and its caller must hold, checked
with the run's live authority like other host calls. The kind is resolved
against the run's revision: its enablement's commit, else its deployment's.
Scans record the project's resolved kinds and their opt-in
(`trigger_definition_scans.project_kinds`, added by this change's migration);
a commit scanned before it has none and is refused until deployed again.

**Polling is a recipe.** The `github-polling` registry pack (ADR 0262) is a
schedule workflow that reads the repository's recently updated pull requests
and comments through the project's `github` connection (`get` on the REST
API: one text source for everything compared), keeps its cursor and a
snapshot of each pull request's head in a store document written with
`ifVersion`, records nothing on its first run (a baseline), skips comments
by `Bot` accounts, and records `github.pull_request` (opened, synchronize,
reopened, ready_for_review, closed), `github.issue_comment` and
`github.pull_request_review_comment` events shaped like the webhook's
deliveries with stable ids. The `pull-request-reviews` pack then works
unchanged on a private server.

Considered: GitHub polling in the server (an integration in the framework,
which ADR 0171 rejected for kinds); a single-event `record` (a poll would
need one boundary per event); letting workflows record host kinds (a forged
`session.*` event would act with authority the workflow does not hold); a
per-enablement rate limit (the 100-event cap per call and the run's own
schedule bound it today; a quota belongs with the queued runs work if it is
needed).

## Consequences

- A private server runs webhook-shaped automations from any API a workflow
  can poll; downstream workflows never know the difference.
- The desktop's GitHub event source for temporary watchers (ADR 0177) stays:
  watchers poll on the person's machine for a chat's lifetime, which a
  project schedule does not replace. If watchers come to bind deployed
  pollers instead, that source becomes a duplicate and should be removed.
- Polled events arrive one interval late and approximate the webhook's
  actions from snapshots. The recipe documents the tradeoff.
