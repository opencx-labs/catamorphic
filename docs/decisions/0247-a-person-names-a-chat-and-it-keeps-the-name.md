# 0247 — A person names a chat, and it keeps the name

- **Status:** Accepted (amends 0202)
- **Date:** 2026-10-18

## Context

A chat took its name from its first message, and a harness that titles
its conversations (the built-in agent's `set_title`) replaced it. The
person had no way to name a chat themselves.

## Decision

**Rename is one of a chat's verbs, with one dialog.** "Rename…" leads the
chat menu wherever it appears: a sidebar row (Chats, Activity), a chat's
row in the Tabs list, its tab in the strip (after the ways to open it)
and its dock bubble; from the detached dock it brings the chat's window
forward. The palette's "Rename chat…" renames the focused chat. Each
opens the same rename dialog (the action input form, ADR 0234) filled
with the chat's title, read from the server for a chat older than the
loaded list, and empty for an untitled chat. An empty name is refused
there; an unchanged one closes it, claiming nothing.

**The name is the person's command.** `PATCH
/projects/:projectId/agent/sessions/:sessionId/title { title }` records a
`rename` command in the chat's log (ADR 0197) and appends
`session.changed { title }`, so every reader updates from the session's
own event. It works while a turn runs, and only on the host that holds
the chat. `@catamorphic/react` exposes it as `useRenameAgentSession`.

**It keeps the name.** The rename's event carries its command id, and a
harness's title, or an imported tool's own on a later import, is applied
only while the chat's log holds no event a person's rename appended
(`SessionLog.namedByPerson`). A mirror replicates the log, command ids
included, so a copy that goes on elsewhere keeps the name too; a copy
started from a snapshot taken after the rename does not hold the mark.
The first message names only an untitled chat, as before.

Considered: a column marking a person's title, which needs a migration and
a field every snapshot carries; the command receipts table, which only the
holder has and mirrors do not carry; renaming inline in the sidebar row,
which the chat's tab, the dock and the palette could not share.

## Consequences

People name chats from anywhere a chat's menu shows. An agent that sets
titles, or Claude Code titling a session the person keeps using in the
terminal, no longer renames a chat its person named. A server older than
this change answers the rename with not found.
