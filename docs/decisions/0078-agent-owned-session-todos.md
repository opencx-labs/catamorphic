# 0078: Agent-owned session todo lists

- **Status:** Accepted
- **Date:** 2026-08-29
- **Refines:** 0019, 0038, 0061, 0067

## Context

Long agent turns need a compact progress surface that survives refreshes and
works identically across the built-in AI SDK agent, Claude Code, Codex, and
project-defined agents. Harness-native plans are not a sufficient contract:
their item shapes differ, some harnesses have no plan tool, and native items
do not consistently carry the task detail a user needs.

The list is the agent's working plan. Letting the user edit it would create two
authors and make progress state ambiguous.

## Decision

Each agent session owns one current todo snapshot in Postgres. An item has a
host-generated stable id, a short title, a required detailed description, and
one of `pending`, `in_progress`, or `completed`. Replacing the complete ordered
snapshot is the only mutation primitive; it naturally covers creation,
editing, status changes, reordering, addition, removal, and clearing without a
second operation log.

Hosts expose `read_todo_list` and `update_todo_list` as trusted,
session-bound agent tools. These tools are harness-neutral and are the source
of truth even when a harness also has a native planning tool. Public session
responses include the snapshot for read-only rendering, but there is no
user-facing todo mutation route.

Session mirroring carries the current snapshot so remote continuations show
the same progress. A fork starts with an empty list because it is a new working
thread and the source list has no historical state at an arbitrary fork point.

## Consequences

- Every harness gets the same progress semantics and description-rich items.
- Todo updates appear during a turn through normal session polling and survive
  restarts.
- Clients can render progress but cannot become a second list author.
- The full snapshot is bounded to 50 items and 4,000 characters per
  description, keeping session reads and mirrors predictable.
- A future durable runtime may publish the same snapshot through normalized
  plan events, but those events must preserve this contract rather than expose
  provider-specific plan shapes.
