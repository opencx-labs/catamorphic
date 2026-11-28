# 0346 — One set of session operations for every surface

- **Status:** Accepted
- **Date:** 2026-11-20
- **Amends:** 0090 (what raises a chat's attention: any chat that waits on its person, not only a subsession), 0166 (how a member's agent runs a project agent), 0226 (the workflow and MCP names of the metadata write)

## Context

A chat was controlled four ways. REST had create, commands and an event stream. The project MCP had `ask_agent`, one call that sent a message and polled the turn every 250 ms with no exit for a turn that waits on its person: a question hung the call until the client gave up, with the chat's id unknown to the caller, and a failed turn came back as an empty reply. Workflows and the MCP shared `SESSION_ACTION_SCHEMAS`, named `session_${operation}` over camelCase keys beside `send_agent_message` and `set_session_metadata`, and its `create` could not start a chat. A chat that waited on a question raised attention only when it was a subsession.

## Decision

Core holds one registry, `SESSION_OPERATIONS` (`services/session-operations.ts`): each entry is a snake_case name, a title, a description, a Zod input and output, annotations, the OAuth scope it needs, and one method of `SessionOperationsService`. REST (`POST .../agent/sessions/start` and `/wait`, the turn restart), both MCP endpoints, in-product agent tools and workflows' `host["catamorphic.sessions"]` (the name without `session_`, camelCased) all project it; nothing else names an operation.

Eight operations control a chat: `session_start` (create and deliver in one call, answering at once), `session_send`, `session_wait`, `session_read`, `session_answer`, `session_interrupt`, `session_close`, `session_list`. The rest keep their meaning under the same naming: `session_fork`, `session_spawn`, `session_archive`, `session_unarchive`, `session_restart`, `session_complete`, `session_reopen`, `session_stop_watcher`, `session_set_metadata`, and `session_changed_paths` (the paths that differ between two commits of a chat, [ADR 0355](0355-hooks-are-triggers-a-waited-event-and-setup-asks-before-it-replaces.md)). `ask_agent`, `send_agent_message`, `stop_watcher`, and the `create`, `inspect`, `find`, `history`, `results`, `usage` and `attempts` operations are gone: `session_read` takes `include` for the transcript, every result, usage, a turn's attempts and metadata, and `session_list` takes `key`. A chat is still named by `sessionId` or by its key (ADR 0173). `POST .../subsessions/wait` is gone.

The eight answer with one `SessionState`: `state` (`working`, `needs_input`, `idle`, `failed`, `closed`), a `cursor`, the working `turn`, pending `requests`, the settled `reply`, typed `results`, `pullRequests`, `error`, and `waiting` when the chat waits for a machine (read from `placement_waits`, ADR 0258). A failed turn is `state: "failed"` with its error. Refusals carry a code (`not_found`, `not_authorized`, `invalid_input`, `agent_unknown`, `environment_unavailable`, `environment_full`, `authentication_required`, `session_closed`, `session_elsewhere`, `request_not_pending`, `idempotency_conflict`, `internal`) and `retryable`. Start, send, answer, interrupt and close take an `idempotencyKey`, recorded per actor, so a retry returns the first result on any replica.

An agent that starts waiting on its person, or a turn that fails, raises the chat's attention for every chat: the session log bumps `attention_revision` in the transaction that writes the pending, answerable, blocking request, and the engine reports opened requests so the chat's owner gets the `agent_question` notification. A host's `onAgentTurnSettled` is not told: the turn has not settled.

Alternatives: keeping `ask_agent` with a timeout still loses the chat's id on a dropped connection and still blocks the caller; separate schemas per surface is what drifted.

## Consequences

- An outside client acts as the member's assistant, an in-product tool as its chat's agent, a REST client as the person; none needs a `fromSessionId`.
- Workflows' `deliver`, `exec` and `stop` stay beside the registry: keyed delivery with approvers and alerts is more than `send`. `sendMessage` stays in core for hosts that run one turn in process, sleeping on the session feed.
- `set_session_metadata` stays the tool an agent has for its own chat (ADR 0226) on a session's own connection.
- Follow-up: fold the in-product subsession tools (`spawn_subsession`, `wait_for_subsessions`, `interrupt_subsession`) onto the registry.
