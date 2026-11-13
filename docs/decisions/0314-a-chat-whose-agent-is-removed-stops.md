# 0314 — A chat whose agent is removed stops until another is chosen

- **Status:** Accepted
- **Date:** 2026-11-14

## Context

A chat saves the id of its agent. Removing a profile agent, or a committed
project agent's file, left that id pointing at nothing. The next turn failed
with `Coding agent '<id>' is not configured` and offered Retry, which could
never succeed. Other references to the agent stayed too: other agents'
subsession grants and the voice assistant setting.

## Decision

A chat whose agent no longer exists stops. Its turn fails with the error
kind `agent_missing`, and the chat offers **Choose an agent** instead of
Retry. Choosing one switches the chat's agent the usual way, recording the
change in the transcript, and runs the stopped turn again. The chat shows
"Deleted agent" before anything is sent.

Removing an agent asks for confirmation, saying its chats will stop. Before
it goes, the subsessions agents started on it are archived
(`archiveSubsessionsOnAgent`), so their turns stop as archived ones do.
Forks and subsessions the person keeps in their list are theirs and stay.
Removal also drops the agent from other agents' subsession grants and
returns the voice assistant to the default agent.

A committed project agent whose file exists but does not load is invalid,
not removed: its chats fail with the definition's error, since the fix is
in the file.

Switching such chats to the default agent automatically was rejected. It
could carry a Claude Code conversation over to Codex, or to another
account, without the person choosing that.

## Consequences

The rule is core's: the error kind reaches every client, and an agent that
disappears for any reason (Settings, a git pull, a host policy) stops its
chats the same way. A host that removes agents calls
`archiveSubsessionsOnAgent` for their subsessions.
