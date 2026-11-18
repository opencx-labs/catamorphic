# 0323: Agents submit typed results

- **Status:** Accepted (amends 0050, 0090, 0197, 0259; results are bounded per turn, not per chat, and patterns run in linear time, by [0336](0336-reviews-show-progress-and-post-findings-as-verified.md))
- **Date:** 2026-11-17

## Context

What an agent produced was text. A subsession's result reached its parent as a
message; a workflow that acted on a chat's work parsed its reply. The pull
request review pack had the reviewer end every turn with a fenced
`work-review` JSON block that its publisher extracted (ADR 0259). A production
pull request reviewer, a coordinator with subagents, had to build typed
submissions as harness plugin tools, because text results kept breaking: prose
before the JSON, arrays sent as JSON-encoded strings, a required field
missing, a turn ending with reasoning only, compaction hiding earlier answers,
a mistyped child id. Its rules held: only an accepted, validated submission
counts; field errors go back to the agent in the same turn; a newer input
makes earlier submissions stale; the parent reads its children's accepted
results, and code computes the final checks over them.

## Decision

**A committed agent definition declares its results.** `.work/agents/<slug>.json`
may carry `"results": { "<name>": <JSON Schema> }`. Names are lowercase
(`^[a-z][a-z0-9_-]{0,63}$`), at most 16; the schemas together stay under
64 KiB and must compile as JSON Schema 2020-12 (Ajv, already in the
dependency tree), or the definition is invalid. Each schema compiles in an
Ajv of its own, so a reused `$id` neither collides with nor resolves
another definition's; a core keeps a bounded cache of compiled schemas keyed
by digest (replica memory (b), ADR 0193). Patterns run on agent-submitted
values in the server's process, so they run on a linear-time engine (RE2
semantics, re2js, through Ajv's `code.regExp`), never JavaScript's
backtracking one, with ECMAScript's meaning (corrected by ADR 0336: the
first version kept JavaScript's engine behind heuristics that missed bounded
repeats). A pattern is refused when the definition loads unless JavaScript
accepts it with the `u` flag; where RE2 reads alike syntax otherwise, `\s`,
`\S` and `.` are rewritten to JavaScript's meaning, and what cannot be carried
over is refused (a backreference, lookaround, `\S` inside a class, a repeat
over 1,000). One pattern compiles, once per source, to at most 2,000
instructions, a definition's patterns to 50,000. A value with text over 4,096
code points where a pattern applies is refused. One check of a value (its
JSON-text decoding included) stops matching once 100 ms have passed, so its
worst case is about that plus one match (4,096 code points through 2,000
instructions, tens of milliseconds); refused submissions count toward a
turn's 100 (ADR 0336), so a turn's checks block the event loop for at most
about 15 seconds in all, spread over its submissions. Results name the agent's output, not its authority, so they stay outside
the consent hash, like `skills`.

**`submit_result { name, value }` is a Work tool.** Core offers it beside
`ask_user` and `close_questions` to every turn of an agent that declares
results, on every host and harness (the host tools every runner serves),
read-only chats included: it writes only the chat's own log. Its
description lists each name with its schema. The value is validated
against the named schema; a rejected call stores nothing and answers, as
the tool's error, each failing field's path and message, so the agent
corrects it in the same turn. A string value that fails but decodes once
as JSON to a valid value is accepted decoded; one that decodes to a value
that still fails is reported with the decoded value's fields, saying it
arrived as text. Only the attempt that runs a working turn records: the
tool checks, under the session's lock, that its calling attempt is still
the turn's active one, so a call that finishes after a takeover or after
the turn ended records nothing. Values are bounded to 256 KiB of JSON and
1,000 results per chat.

**An accepted result is an item.** `result` joins the item kinds of the
session log (ADR 0197): `name`, `value`, `input` (the id, position and
kind of the newest input the chat had taken in when it was submitted, or
null),
and `commit` (the workspace commit the turn began on, or null), beside the
item's own session, turn, attempt and time. Results are never rewritten:
a context hand-off, compaction or harness change leaves them where they
are, and a fork copies them as its own history like every item.

**A result is current until a new request arrives.** A result is `current`
while no new request reached the chat after its `input`: a person's
message, or words a workflow, an assistant or a session outside the chat's
own subsessions (at every depth) sent, unless its turn was cancelled or
rolled back. Task notifications (a command
finishing, a watch firing) and messages from its own subsessions are the
agent's own work reporting back, so they leave it current; otherwise a
coordinator's final result would go stale whenever a late child update or
a command's notification arrived after it. A reader that wants a stricter
rule applies it to `input.kind` itself.

**Readers are code.** The session operation `results({ sessionId | key,
name?, family?, afterInput?, limit? })` answers newest first, each result
with its source session; `family: true` includes the chat's subsessions at
every depth; `afterInput` keeps the named chat's results whose input is
that input or a later one, and subsessions' results recorded after it
arrived. A subsession's results reach only callers who may read that
subsession, in `results` as in `list` and `wait`. The same operation is `session_results` on the project MCP and
`GET …/agent/sessions/:id/results` over REST. Results of rolled back turns
are left out. A parent agent reads its children's latest result of each
name in `list` and `wait` outputs and in the message a finished child
sends it; a large value is marked truncated there, read whole with
`session_results`.

**Recording a result is a session event.** `session.result-recorded`
carries the result in its detail and the session snapshot, with
`payload.session.key`, so a workflow acts on it the moment it is recorded,
mid-turn. The database trigger that publishes session events emits it, so
both hosts do.

**A mirrored result is the pusher's word.** A desktop pushing its chat to a
server (ADR 0197) carries its result items. The server checks each against
its own definition of the chat's agent; one it does not accept is kept as
`failed` (the log stays whole) and no reader counts it. A pushed
`session.result-recorded` is kept only for an accepted item, with that
item's own fields, and names the pusher as its actor, never the agent.
So a mirrored result is as trustworthy as the member who pushed it: valid
by this server's schema, not proof that an agent produced it.

**The timeline shows that a result exists.** A result is a step of the
turn's work: one row naming it, expanding to its value.

**The review pack submits its review.** The reviewer declares a `review`
result (the former block's contract as JSON Schema) and submits it; the
publisher reads the turn's latest `review` result instead of parsing the
reply, and the fenced block is gone. The publisher still checks the value
itself: the sandbox that wrote it is untrusted (ADR 0259).

Considered: results as session metadata (ADR 0226), which is mutable and
keyed, so a later write erases what an earlier input produced; a separate
results table beside the log, a second source of truth a mirror would not
carry; validating with Zod schemas in code, which a committed definition
cannot hold.

## Consequences

Agents and workflows exchange typed values without parsing prose, and
stale answers are distinguishable from current ones. Hosts that build
agents from definitions pass `results` through (core does for
server-registered project agents; the desktop's registry does for its
own). A migration adds the item kind and the event. Mirrors carry result
items like any item. Hand-offs do not yet tell a new provider thread which
results it already submitted (ADR 0328 continues this).
