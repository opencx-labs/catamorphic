# 0214 — A chat runs on one harness

- **Status:** Accepted
- **Date:** 2026-10-08
- **Amends:** [0198](0198-agent-runners-run-harnesses-beside-their-workspace.md)

## Context

ADR 0198 let a started chat switch to an agent on another harness: the next
turn handed the new harness a summary of the turns it had not seen, the
person's messages verbatim. People reported talking to Claude and then
finding the conversation in the ChatGPT app. A Codex agent on this
machine's sign-in keeps its threads in `~/.codex`, which the ChatGPT app
lists, so one switch to Codex (and back) left the conversation there while
the chat said Claude. Every later return to Codex sent it what happened in
between. The switch was also lossy: a summary is not the native thread, and
the two harnesses' tools, files and permissions differ.

T3 Code allows the same handoff. We do not: a chat should be where the
person thinks it is, and nothing about it should land in another product
without an act that says so.

## Decision

**A session is bound to the harness its first turn runs on.** The turn
engine records the harness on the session (`harness`, a session field in the
log, null until the first turn) when it binds the first provider thread. A
fork continues its source's conversation, so it is born bound to the
source's harness.

- **Before the first turn**, any agent can take the chat.
- **After**, `PATCH …/agent/sessions/:id` accepts only an agent on the bound
  harness and answers `409 harness_fixed` otherwise, checked again under the
  session's lock. The next turn resumes the same native thread.
- **A turn whose agent reaches another harness** some other way (a project
  agent's definition changes its kind) fails, saying the chat runs on its
  harness, rather than hand the conversation over.
- **An agent that cannot run** (a registry entry with `unavailable`, such as
  a project agent awaiting approval) fails its turns with that reason and
  binds nothing. Its harness is unknown, so `PATCH` accepts it; once it can
  run, a turn on another harness fails as above. The desktop asks for
  approval before it applies a pick, so it always compares real harnesses.

Clients offer an agent on another harness as a new chat with it. The
desktop's agent picker labels those rows "starts a new chat".

The `context_handoff` item stays for what ADR 0198 also uses it for: a
fresh thread on the same harness where native state was lost (a fork whose
harness cannot fork natively among them), a subsession that inherits its
parent's history under a delegation route, and a mirrored copy continued on
another host. Each copy binds its own harness; mirrors do not carry it
(ADR 0197).

Alternatives considered: keeping the handoff with a warning on the row
(the conversation still leaks, and a warning read once is forgotten by the
next switch back); forking into a new chat on the other harness with the
handoff (an explicit act, but the summary still lands in that harness's
history, and the fork's first answer comes from a lossy summary). A new
chat is the honest version of both.

## Consequences

- What the chat shows is the harness that has its conversation, and only
  that harness has it.
- Switching between agents on one harness (two Claude accounts, different
  instructions or tools) stays in place and native.
- A person who wants another harness's view of a conversation starts a new
  chat and says what it needs; carrying context across becomes an explicit
  act a future feature can design (for example, attaching the transcript).
- Sessions that ran before this change take the harness of the thread they
  ran on last (migration `060_session_harness.sql`); mirrored copies bind on
  their own next turn.
