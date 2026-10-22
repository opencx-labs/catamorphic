# 0233 — Sessions imported from Claude Code and Codex

- **Status:** Accepted (amended by [0276](0276-a-chat-can-switch-agents-and-harnesses.md): any agent may continue an imported session)
- **Date:** 2026-10-15
- **Relates to:** [0062](0062-session-privacy-and-fork-ux.md) (local-only chats), [0197](0197-agent-sessions-are-an-event-log-of-turns.md) (the log, fork), [0198](0198-agent-runners-run-harnesses-beside-their-workspace.md) (handoffs), [0229](0229-idle-pollers-wait-for-hints.md) (hints, not polling)

## Context

People run Claude Code and Codex in terminals and in other apps on the same
repositories they open in Work. Those chats never reach Work, so the
history of one project is split across three apps, and Work's own tools
(chat list, search, `list_project_sessions`) see only a third of it. Both
CLIs keep complete transcripts on disk: Claude Code in
`~/.claude/projects/<escaped-cwd>/<id>.jsonl`, Codex in rollouts under
`~/.codex/sessions/`. Work's own Claude Code and Codex chats on the
person's sign-in are written there too.

## Decision

**An imported session is a Work session.** Core records the origin as a
typed field, `imported { harness, nativeSessionId, sourcePath,
contentSha256, sourceModifiedAt }` (`agent_sessions.imported`, one session
per person, project, harness and native id), and it travels in
`SessionFields` and the session list. Everything that reads sessions
(chat list, palette, search, `list_project_sessions`, the phone) sees it
with no plumbing of its own. Considered: a desktop-only index beside
incognito state; nothing but the desktop would see it, which is half the
point of importing.

**Continued only by its own tool's agents, enforced by core.** An import is
created as any chat is (an Environment and its allocation) and bound to
its tool's harness (0214), on the agent whose switch imported it. A
message is accepted only while the chat's agent runs on that harness
(`AgentSessionImportedError`, 409 `imported`, otherwise), and the agent
picker offers only those agents. Claude Code's own records are stored as
the session's native state (a provider thread holding the tool's session
id, marked as having seen every imported turn), so the first turn here
resumes Claude Code's own session and is handed nothing. A Codex rollout
can reach a gigabyte and is not stored: its first turn starts a thread of
its own, handed the transcript (0198). Once Work ran a turn in it, the
file is no longer read (`taken_over`): what the tool writes after that
stays in the tool. Hide is archive, and a hidden import stays hidden when
its file grows.

**Transcripts become items through the harness packages.**
`@catamorphic/claude-code` reads a Claude Code transcript with the same
translator its live turns use, so imported items look exactly like
Work's own; `@catamorphic/codex` reads rollouts (the completed-item
records of current versions, and the response records of older ones).
Both produce one host-neutral `ImportedTranscript`
(`@catamorphic/agent-protocol`): turns of items with stable native keys.
Core turns that into the log's own events; a re-import appends what is
new and changes what changed (keyed by native id), so a chat open on
screen follows a CLI that is still writing. An unchanged hash writes
nothing.

**Work's own sessions are never imported.** Core skips a native id one of
its provider threads already holds, inside the import's transaction. The
desktop also skips Claude Code side chains, Codex subagent threads and
the rollouts Codex Desktop made from Claude Code transcripts.

**The desktop decides what to import and where.** A Claude Code or Codex
agent's "Sync chats from" switch (`syncSessions`, off by default) turns
it on for that tool in its profile, and continuations run on that agent;
one agent per tool holds it. It is a choice about the agent, not the
workspace: whoever runs Claude Code outside Work has a Claude Code agent
inside it. Only sessions that start after it was turned on are imported
(no backfill). Directory watches on both stores are hints (0229); a file
is read when it settles, and a last turn left open is read once more
when it would read as ended. A look over the stores (at launch, or when
a switch changes) reads only files changed since the last complete one
began, and a session that will never import keeps only that verdict. A
session belongs to the project whose folder holds its working directory,
or holds the main checkout of the worktree it ran in. Connected projects
(0098) do not import.

**Imported sessions stay on this computer.** The mirror pusher skips them
as it skips incognito chats (0062): terminal history stays private, even
once Work continued it, and a fork is an ordinary chat that syncs like
any other.

## Consequences

Migration 065 adds `agent_sessions.imported`. The session protocol stays
2: the field is optional on the wire, and a mirror base never carries one.
Claude Code and Codex formats change without notice; their readers skip
what they do not know and their tests pin real-shaped records. Backfill of
older sessions can come later as an explicit action over the same
import.
