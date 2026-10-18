# 0260: Every returned call carries state

- **Status:** Accepted
- **Date:** 2026-10-18
- **Amends:** [0020](0020-typed-durable-workflow-boundaries.md), [0024](0024-postgres-durable-pauses.md)

## Context

A boundary returns one call: a connection action, a host call (sessions,
secrets, documents), or a child workflow. The call's result became the next
boundary's whole input (ADR 0020); only `pause` kept data across, in its
`state`. So a workflow could not combine what it knew before a call with
what the call returned: the review poster (ADR 0259) reads a pull request's
diff and must still hold the parsed report, the turn, and the commit the
chat stands on. Slack's poster worked only because `history` happens to
return the chat's key. Workarounds (stashing a plan in a store document,
encoding ids in the bodies GitHub returns) were fragile and unreadable.

## Decision

**Every returned call takes an optional second argument `{ state }`,** as
`pause` already does: `connections.github.get(args, { state })`,
`host["catamorphic.sessions"].history(args, { state })`,
`documents.read(args, { state })`, and `callWorkflow(child, { input, state })`.
With state, the next boundary receives `{ result, state }`; without it, the
result alone, as before. The types are overloads (`TransitionCall`,
`HostCall`, `CallWorkflow`), so `state` flows into the next step's
`BoundaryContext<Carried<Result, State>>` and the step chain is checked as
any other; the boundary's JSON check covers the state.

**State is persisted with the run.** The runtime records it on the
transition (`statePresent`, `state`) and refuses any other second argument.
Host and connection calls finish within their step, so core wraps their
result there. A child workflow outlives its step, so the waiting step
attempt holds the state (`call_state_present`, `call_state`, migration 066)
until the child ends. A retried step runs its callback again and so the
call, with the state it computes.

Considered: giving each step every earlier step's output (unbounded inputs,
and steps coupled to positions), merging results into earlier inputs
(silently shadowed keys), and a dedicated "carry" call (one more transition
per hop). Explicit state keeps each step's input exactly what its
predecessor chose to hand on.

## Consequences

Multi-call workflows read top to bottom: read, carry what matters, act.
Loops are still not a workflow construct; actions that apply to several
items take lists where retrying them is safe (ADR 0259). State is stored per
step, so workflows should carry ids and the data later steps use, not whole
responses.
