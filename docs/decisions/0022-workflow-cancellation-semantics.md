# 0022 — Workflow cancellation is a host run control

- **Status:** Accepted
- **Date:** 2026-07-22
- **Implemented and updated by:** 0025 (state machine), 0026 (one Run control surface)

## Context

Workflows may be authored with resumable pauses, but cancellation is
terminal and can be requested at any point. Modeling it as another boundary
transition or pause outcome would incorrectly continue into the next boundary
and let workflow code appear to grant authorization.

## Decision

Cancellation is an authenticated, idempotent control-plane operation on a run
instance. The embedding host owns authorization and whether to expose the
control. Definitions may declare `controls: { cancel: true }` for
static visualization and host UI discovery, but absence does not prevent a host
from performing emergency cancellation.

`BoundaryContext` remains `{ input, pause, callWorkflow }`. There is no authored
`cancel()` transition and cancellation is not a `PauseResult`; canceled runs do
not start another boundary. Postgres remains authoritative and providers are
asked to terminate active compute. Cancellation cannot roll back external
effects already started, so idempotency and reconciliation remain required.

At the time, existing regular and batch cancellation APIs were the operational
precedent. ADR 0025 implemented cancellation execution, child propagation,
pause cleanup, and request-versus-acknowledgment states. ADR 0026 then unified
them behind one Run control surface.

## Consequences

Pause/resume and cancel retain different continuation semantics. Authors cannot
escalate their own permissions through workflow source, and hosts can implement
policy consistently across Workflow capabilities. Provider termination remains
best effort for active compute, while Postgres has the authoritative state.
Cancellation performs no automatic compensation for external effects.
