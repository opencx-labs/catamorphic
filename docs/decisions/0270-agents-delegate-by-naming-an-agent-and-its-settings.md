# 0270 — Agents delegate by naming an agent and its settings; grants decide

- **Status:** Accepted (amends 0090)
- **Date:** 2026-10-20

## Context

ADR 0090 made subsessions first-class and gave agent definitions
delegation routes: named edges (`id`, `target`, `allowFurtherDelegation`)
the model picked by id. Two things went wrong in practice.

- **Agents named the wrong thing.** The prompt listed routes as
  `same-agent: <agent id>`. Agents passed the agent id as the route, and 38
  of 67 spawns over four days were refused. A model wants to name who
  should do the work, not which grant allows it.
- **A child could not be shaped.** It ran on its agent's configured model
  and effort, with no way to start a stronger or cheaper copy, or a
  read-only reviewer. It did not even keep the model the person had picked
  for the parent chat.

## Decision

**The tool names an agent and its settings.** `spawn_subsession` takes:

- `task`;
- `agent`, omitted for a copy of the caller;
- `model` and `effort`;
- `read_only` and `delegate`;
- `context_mode` and `title`.

There is no route id. Workflows' `spawn` action and the server API take the
same fields.

**Grants decide.** An agent definition's `delegation` lists `agents`. Each
grant names who may be started and what the parent may choose for them:

- `agent`: `self`, an exact agent id, `project:<slug>`, or `*` (any
  accessible agent whose sandboxing is no wider than the caller's, as
  before);
- `model`: `any` (any model the target's harness offers), `fixed` (no
  choice), or a list;
- `effort`: `any`, `fixed`, `at-most-parent` (no higher than the parent
  chat's), or a list;
- `delegate`: whether the child may start its own;
- `description`, shown to the agent.

A request takes the first grant that admits the agent and permits the
settings. A refusal lists what is allowed. `maxConcurrentChildren` and
`enabled` stay.

**By default an agent may start copies of itself with any model and
effort.** An absent `delegation` means one grant:
`{ agent: "self", model: "any", effort: "any", delegate: true }`. Omitted
grant fields mean `any` and `true`. A stronger child is allowed by
default, because that is the point of delegating hard work. The voice
assistant, on a fast model, starts work on a stronger one. People who want
children at or below the parent configure it.

**A copy starts from the parent chat.** A child of the caller's own agent
takes the parent session's current model and effort unless the request sets
them. Any other agent starts from its own defaults.

**Narrowing is always allowed.** `read_only` and `delegate: false` only
take power away, so no grant gates them.

- `read_only` runs the child in its harness's read-only mode: Claude Code's
  `plan`, Codex's `read-only` sandbox. Harnesses without one refuse it by
  name.
- A child's onward delegation is the grant's `delegate` and the request's,
  together.
- Widening (more sandboxing, other tools) is never a spawn setting. It
  takes another agent definition and an explicit grant, as in 0090.

**The harness decides what exists.** A model or effort must also be one the
target agent's harness offers: a chat runs on one harness (0214). Core asks
the host through an optional `CodingAgentRegistry.models()`, the same
catalog the model picker shows. Without one, the harness itself is the
check at the first turn. The catalog is consulted only when a spawn names
a model or effort, so creating a chat never waits on it.

## Consequences

- The prompt lists whom an agent may start and what it may set, never an
  id to copy. Errors name the valid choices.
- The voice assistant's `start_session` takes `model` and `effort`, so the
  person can ask it to put a stronger model on the work.
- `agent_delegations.route_id` becomes `grant_agent`: the grant that
  admitted the child. The child's model, effort and read-only flag live on
  its session, which gains `read_only`.
- Agent definitions and profile agents move from `routes` to `agents`, a
  clean break.
  - A committed definition that still has `routes` is invalid, with a
    message naming the replacement. Dropping it silently would widen what
    a shared definition allows.
  - A profile agent's old `routes` give way to the default.
- The agent settings screen edits grants: per agent, whether it may be
  started, its model and effort choices, and onward delegation.
