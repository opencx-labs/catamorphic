# 0247 — A person names a chat, and it keeps the name

- **Status:** Accepted (amends 0202)
- **Date:** 2026-10-18

## Context

A chat took its name from its first message, and a harness that titles
its conversations (the built-in agent's `set_title`) replaced it. The
person had no way to name a chat themselves.

## Decision

**Rename is one of a chat's verbs.** "Rename…" leads the chat menu
wherever it appears: a sidebar row (Chats, Activity), its tab and the
dock. It opens the action input form (ADR 0234) with the current name;
an empty name is refused there.

**The name is the person's command.** `PATCH
/projects/:projectId/agent/sessions/:sessionId/title { title }` records a
`rename` command in the chat's log (ADR 0197) and appends
`session.changed { title }`, so every reader updates from the session's
own event. It works while a turn runs, and only on the host that holds
the chat. `@catamorphic/react` exposes it as `useRenameAgentSession`.

**It keeps the name.** A harness's title is applied only while no
accepted `rename` command is in the chat's log; the first message names
only an untitled chat, as before.

Considered: a column marking a person's title, which needs a migration and
a field every mirror carries while the command log already records who
renamed; renaming inline in the sidebar row, which the chat's tab and the
dock could not share.

## Consequences

People name chats from anywhere a chat's menu shows. An agent that sets
titles no longer renames a chat its person named. A server older than
this change answers the rename with not found.
