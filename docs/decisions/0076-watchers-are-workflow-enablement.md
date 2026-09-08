# 0076: Watchers are temporary workflow enablements

- **Status:** Accepted
- **Date:** 2026-08-29
- **Supersedes in part:** 0074
- **Refines:** 0039, 0040, 0068

## Context

ADR 0074 introduced temporary Watchers, but the first implementation gave
them a second trigger model. Event kinds were supplied outside workflow code,
stored on a Watcher row, and dispatched directly to `RunsService`. Normal
workflows already declare `trigger()` bindings in TypeScript, and
`TriggersService` already parses, validates, authorizes, and fires them.

Two trigger models make workflow code harder to understand and allow the
database subscription to disagree with the code that actually runs.

## Decision

A Watcher is a session-scoped, expiring enablement of an ordinary immutable
workflow revision. It is not a workflow category and it does not define a
trigger syntax.

Watcher source uses the same exported `defineWorkflow` value and inline
`triggers: [trigger(kind, config)]` declarations as every other workflow. The
Watcher creation API accepts source and lifecycle options, never a parallel
list of event kinds. Creation scans the pinned commit through
`TriggersService`, requires the selected workflow to have at least one valid
binding, and derives the displayed trigger kinds from that frozen projection.

Monitors only observe external systems and append normalized Project Events.
The Watcher dispatcher advances the temporary enablement cursor and asks
`TriggersService` to fire the selected binding at the pinned commit. Trigger
kind registration, payload and config validation, connection authorization,
run enrollment, and correlation handling remain the regular trigger path.

GitHub Project Events are registered ordinary trigger kinds. The desktop
ships those registrations with its other trigger kinds, so an agent can write
`trigger("github.pull_request", {})`, create a GitHub Watcher, and receive the
normalized Project Event envelope when the connected user can read the
repository.

Temporary source remains on the dedicated git ref specified by ADR 0074 for
this slice. Profile-scoped private workflow source is deferred separately.

## Consequences

- Workflow TypeScript has one trigger model.
- A Watcher row stores lifecycle and revision identity, not duplicated event
  subscriptions.
- Adding another event source requires a Monitor provider and ordinary
  trigger-kind registrations, not Watcher-specific workflow machinery.
- Existing Watcher creation callers must move event kinds into workflow code.
  There is no compatibility input or fallback inference.
