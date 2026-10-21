# 0271 — Agents delegate by naming an agent and its settings; grants decide

- **Status:** Accepted (amends 0090, 0216)
- **Date:** 2026-10-20

## Context

ADR 0090's delegation routes were edges the model picked by id; agents
passed the agent id instead, and 38 of 67 spawns on one desktop in four
days were refused. A child ran on its agent's defaults: no stronger or
cheaper copy, no read-only reviewer. The voice assistant had its own
`start_session` for the same thing.

## Decision

**The tool names an agent and its settings.** `spawn_subsession` takes
`task`, `agent` (omitted: a copy of the caller), `model`, `effort`,
`read_only`, `delegate`, `context_mode` and `title`. No route id. The
workflow `spawn` action and the server API take the same, as `agentId`,
`readOnly`. The voice assistant uses it too; `start_session` is gone
(amending 0216).

**Grants decide.** `delegation.agents` lists grants: `agent` (`self`, an id,
`project:<slug>`, or `*`), `model` (`any`,
`fixed`, or a list), `effort` (`any`, `fixed`, `at-most-parent`, or a
list), `delegate`, and a `description`. Grants that name the target decide
before `*`, so `*` never lifts one agent's limits; among them, the first
that takes the settings applies. Refusals list the choices. `*` admits the
agents the menu names, no wider than the caller's sandboxing: those the host
lists (also by project id, where the host serves them so) and the project's
committed agents. An id the host resolves but does not list, or a
definition not yet committed, needs a grant that names it.

**By default an agent starts copies of itself on any model and effort**;
omitted grant fields mean `any`. Handing hard work to a stronger model is
the point. Children at or below the parent take `at-most-parent` or lists.
An agent's own model is its default, not its ceiling (amending 0090);
`fixed` holds it.

**A copy starts from the parent chat**: its model and effort, as a pair, so
a new model drops the old effort. Another agent starts on its own defaults.
A grant's list bounds what the child runs on: an unlisted inherited or
default setting gives way to the first listed. `at-most-parent` caps the
effort it runs on at the parent's, when the parent's is known.

**The assistant stays Work's.** The voice assistant is one of the person's
agents plus assistant tools, under an id of its own that Work never lists.
Its grants name its base agent and `*`; it starts no copy of itself. Its
`spawn_subsession` is Work's, wrapped: left without an agent it starts the
base agent, the task goes in a brief leading back to it, and it follows
the child's notes. The menu names every agent a grant reaches, committed
ones included, so the model matches spoken names.

**Narrowing needs no grant.** `delegate: false` and `read_only`. A read-only
chat runs in its harness's read-only mode (Claude Code `plan`, without a
shell; Codex's `read-only` sandbox; others refuse), keeps only host tools
marked `readOnly` and its subsession tools, counts as `contained` for
capabilities, connections and connectors, and its host mounts nothing that
writes (the turn context says `readOnly`). Its children and forks read only
too. Widening is never a spawn setting.

**The harness decides what exists.** A model and effort must be ones the
target's harness offers (0214). Core asks the host's optional
`CodingAgentRegistry.models()`, the model picker's catalog, only when a
spawn names a setting, waits at most five seconds, and otherwise leaves the
check to the harness. A catalog's names match any case, by alias or the
version it resolves to.

### Alternatives considered

- **Print route ids unambiguously, or accept agent ids for them.** The
  model would still name a grant, or have two ways to name one choice,
  and could not shape the child.
- **Children at or below the parent by default.** Defeats delegating hard
  work to a stronger model; it stays one setting away.
- **A voice tool of its own.** `start_session` differed only in a brief,
  a default and fuzzy names, all the parent's, and lacked read-only.
- **`copiesAs` on registered agents** (shipped briefly): a copy of the
  assistant ran as its base agent through core. It put the host's
  assistant into core's contract; listing decides instead.
- **Read-only as an agent with `contained` sandboxing.** Needs a definition
  per reviewer; the session-level flag reuses `contained` for what Work
  enforces and adds only the harness's own mode.

## Consequences

- The prompt lists whom an agent may start and what it may set; a copy is
  started by leaving `agent` out. An assistant chat created before this
  has no list; a refusal lists the choices.
- `agent_sessions.read_only` and `AgentSession.readOnly` are new;
  `agent_delegations.route_id` becomes `grant_agent`, old route names mapped.
- A committed definition that still has `routes` is invalid, with a message
  naming the replacement: dropping it silently would widen what it allows.
  A profile agent's routes become grants, keeping whether delegation is on.
- The settings screen edits grants per agent (model any or its own, effort
  any, up to the parent's or its own, onward delegation); lists come from
  definitions and are kept.
