# Watcher trigger unification

## Goal

Make a temporary Watcher an enablement of a normal workflow revision. An agent
must author ordinary inline `trigger()` declarations, including GitHub kinds,
and the existing trigger service must validate and dispatch them.

## Invariants

1. TypeScript is the only source of trigger subscriptions.
2. Watcher creation has no `eventKinds` input and no inference fallback.
3. The selected workflow must export `defineWorkflow` and declare at least one
   registered, valid trigger binding.
4. A Watcher stores lifecycle, owner, session, monitor, pinned revision,
   environment, cursor, and status. It does not store trigger subscriptions.
5. Monitors append Project Events. They never select workflows or start runs.
6. Project Event delivery uses the same trigger validation, authorization,
   enrollment, and run-start path as host-fired triggers.
7. The input to an event-triggered workflow is the normalized Project Event
   envelope. Watcher identity is provenance and correlation metadata, not part
   of the workflow input contract.
8. GitHub kinds are ordinary host registrations shipped by the desktop.
9. Profile-scoped workflows are out of scope and remain on TODO.

## Runtime flow

```text
GitHub polling or webhook
  -> ProjectEvent monitor/provider
  -> deduplicated Project Event
  -> active temporary workflow enablement
  -> TriggersService binding at pinned commit
  -> canonical immutable Workflow Run
  -> optional session delivery capability
```

The dispatcher reads events after each Watcher's cursor. For an event whose
kind is not bound by that Watcher's selected workflow, it advances the cursor
without a run. For a match, it fires only that workflow at the pinned commit,
records event/run provenance, and advances after successful enrollment.
Redelivery uses the existing correlation conflict policy and provenance
uniqueness.

## GitHub trigger contract

The initial desktop registrations are `github.pull_request`,
`github.pull_request_review`, `github.check_run`, `github.check_suite`, and
`github.workflow_run`. Their payload is the normalized Project Event envelope:
event id and sequence, project id, source, kind, external id, occurrence and
receipt timestamps, and provider payload. Config is the ordinary empty strict
object. Conditions such as action, branch, author, conclusion, or changed
state belong in workflow TypeScript.

## API and UI

The MCP creation tools accept `workflowName`, `source`, and lifecycle or
placement options. Their instructions show inline `trigger()` authoring. List
responses expose derived `triggerKinds`; desktop chips render that field.
There is no compatibility alias for `eventKinds`.

## Storage

A forward migration removes `watchers.event_kinds`. Frozen bindings remain in
the existing per-commit trigger projection. This avoids a second subscription
table while keeping exact-revision dispatch fast and deterministic.
