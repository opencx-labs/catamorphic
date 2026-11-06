# 0276 - A chat can switch agents and harnesses

- **Status:** Accepted
- **Date:** 2026-10-22
- **Supersedes:** [0214](0214-a-chat-runs-on-one-harness.md)
- **Amends:** [0233](0233-sessions-imported-from-claude-code-and-codex.md)

## Context

People want another agent, including one on another harness, to continue the
conversation they already have. Starting an empty chat when they select ChatGPT
in a Claude chat loses that continuity. The session engine already stores a
native thread per harness and records context handoffs (ADR 0198).

## Decision

Picking an agent changes the existing session, across harnesses too. The idle
session lock, access checks, agent approval and Environment admission still apply.
Agent changes clear model and effort overrides unless the same request supplies
new ones. A draft clears those overrides too.

The next turn resumes that harness's native thread, or starts one. The existing
bounded handoff carries the conversation it has not seen: full coverage for a new
thread and a delta when returning to an old thread. Full session history remains
readable through the session tools. The session's `harness` records its latest
bound turn, not a permanent constraint. Forks and imported conversations follow
the same model; import provenance and native state stay intact.

Selecting another harness deliberately shares context with that harness and its
provider history. The alternative of starting an empty chat is removed. Replaying
all transcript messages on each switch would duplicate the native thread and
ignore the existing bounded handoff primitive.

## Consequences

The visible conversation and session id stay stable. Each harness retains its
native thread and receives missing context when it returns. Rollback closes every
affected harness thread and forks only from the retained turn's own provider
references. Returning to a pending fork receives intervening context, and a thread
that failed before starting still receives full context. Summaries are bounded
and can omit detail; agents can read earlier messages when necessary. Switching
an imported conversation to another harness does not resume the source tool's
native thread in the wrong harness.
