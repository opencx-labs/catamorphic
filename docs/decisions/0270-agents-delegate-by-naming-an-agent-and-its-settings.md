# 0270 — Agents delegate by naming an agent and its settings; grants decide

- **Status:** Accepted (amends 0090, 0216)
- **Date:** 2026-10-20

## Context

ADR 0090 gave agent definitions delegation routes, named edges the model
picked by id. The prompt listed them as `same-agent: <agent id>`, so agents
passed the agent id: 38 of 67 spawns on one desktop over four days were
refused. A child also could not be shaped: it ran on its agent's defaults,
with no stronger or cheaper copy and no read-only reviewer.

## Decision

**The tool names an agent and its settings.** `spawn_subsession` takes
`task`, `agent` (omitted: a copy of the caller), `model`, `effort`,
`read_only`, `delegate`, `context_mode` and `title`. No route id. The
workflow `spawn` action and the server API take the same, as `agentId`,
`readOnly`. The voice assistant starts sessions with it too: its own
`start_session` is gone (amending 0216).

**Grants decide.** `delegation.agents` lists grants: `agent` (`self`, an id,
`project:<slug>`, or `*`, whose sandboxing ceiling stands), `model` (`any`,
`fixed`, or a list), `effort` (`any`, `fixed`, `at-most-parent`, or a
list), `delegate`, and a `description`. Grants that name the target decide
before `*`, so `*` never lifts one agent's limits; among them, the first
that takes the settings applies. Refusals list the choices.

**By default an agent starts copies of itself on any model and effort**, and
omitted grant fields mean `any`. Handing hard work to a stronger model is
the point; the voice assistant on a fast model does it. People who want
children at or below the parent use `at-most-parent` or lists. This amends
0090 for named targets too: an agent's own model is its default, not its
ceiling; a grant author who wants it held sets `fixed`.

**A copy starts from the parent chat**: its model and effort, as a pair, so
a new model drops the old effort. Another agent starts on its own defaults.
A grant's list bounds what the child runs on: an unlisted inherited or
default setting gives way to the first listed. `at-most-parent` caps the
effort it runs on at the parent's, when the parent's is known.

**A copy of a layered agent runs as the agent beneath.** A registered
agent may name `copiesAs`: its copies, and a spawn naming itself, run as
that agent. The voice assistant is one of the person's agents with
assistant tools, so a copy of it is that agent without them, on the
assistant chat's model and effort: never a second assistant. What is the
assistant's alone stays in Work's spawn path: a child it starts is handed
a brief that leads back to it (where the person's words are, how to reach
them, a reply that reads aloud), and it follows the child's notes. Spoken
names are the model's to match: the menu names every agent it may start,
the project's committed agents included.

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

- **Print route ids unambiguously.** The model would still name a grant
  where it wants a worker, and could not shape the child.
- **Accept an agent id where a route id is expected.** Two ways to address
  one choice, and still no settings.
- **Children at or below the parent by default.** Defeats delegating hard
  work to a stronger model; it stays one setting away.
- **A voice tool of its own.** `start_session` was `spawn_subsession`
  with a brief, a different default and fuzzy names; it also lacked
  read-only. The differences belong to the parent, not the tool.
- **Read-only as an agent with `contained` sandboxing.** Needs a definition
  per reviewer; the session-level flag reuses `contained` for what Work
  enforces and adds only the harness's own mode.

## Consequences

- The prompt lists whom an agent may start and what it may set; it never
  shows an id for a copy of itself.
- `agent_sessions.read_only` and `AgentSession.readOnly` are new;
  `agent_delegations.route_id` becomes `grant_agent`, old route names mapped.
- A committed definition that still has `routes` is invalid, with a message
  naming the replacement: dropping it silently would widen what it allows.
  A profile agent's routes become grants, keeping whether delegation is on.
- The settings screen edits grants per agent (model any or its own, effort
  any, up to the parent's or its own, onward delegation); lists come from
  definitions and are kept.
