# 0222 — Desktop harnesses stay warm between turns

- **Status:** Accepted (amends [0198](0198-agent-runners-run-harnesses-beside-their-workspace.md))
- **Date:** 2026-10-12

## Context

People found chats in Work slower than the same agent in the Claude and
Codex apps. Measured on one machine, against a scripted model with no
latency, the difference was all in how Work ran each turn:

- Every turn started its harness cold: a new Claude Code CLI or Codex
  app-server, its MCP connections, plugins and the whole conversation
  loaded again. A turn the warm CLI finished in 0.08 s took 0.9 s cold.
  The first shell command of each turn paid another 0.6 to 0.8 s while
  Claude Code built its shell snapshot again; Codex rewrote its whole
  rollout file from Postgres before resuming the thread.
- Native state lived in `jsonb`, which sorts object keys. A resumed Claude
  Code thread sent its model a history that differed from the one it had
  cached (tool inputs among the reordered objects): 35% of quick follow-up
  turns paid for their whole conversation again, up to 155k tokens,
  against 2% in the Claude app.
- Each transcript append took three transactions and rewrote the
  attempt's runner state with a copy of its entries. On the desktop's
  PGlite, on Electron's main thread, entries landed 1.3 s after the CLI
  wrote them at p90, and a turn's end waited for the backlog.

The native apps keep one harness process per conversation.

## Decision

**A harness session may outlive its attempt.** A host-placed adapter can
keep the harness it started (the Claude Code CLI's streaming query, the
Codex app-server with its thread loaded) once the attempt settles, keyed
by native thread. The next attempt on that thread joins it only when:

- it resumes the same native thread (`resume` or `restore`), and the
  thread's last turn as Work recorded it (`ThreadBinding.lastTurnRef`) is
  the session's own last turn;
- everything fixed when the harness started is the same: working
  directory, environment, executable, model access, MCP servers, host
  tools, plugins, system prompt, permissions, model and effort;
- the session is idle and its process alive.

Otherwise the attempt starts cold, as before, and a stale session of that
thread is closed. A fork or a fresh thread always starts cold. A turn that
failed ends its harness, so whatever failed it (an expired sign-in, a
broken connection) does not meet the retry.

**The attempt stays the unit of work.** Events, host calls, tool policy,
per-turn context, questions and approvals belong to the attempt the
session serves; the session routes its harness's callbacks to it. The
attempt ends with the harness's turn result: the process no longer has to
exit first. Between attempts the harness is idle; anything it reports then
reaches nobody, and what it stores waits for the next attempt.

**Hosts opt in.** The desktop keeps a session warm for 10 minutes of
idleness and at most 6 at once, ending the least recently used first, and
ends them all when it quits (`HarnessAdapter.dispose`). Sandbox runners on
servers still start their harness cold for every attempt: a runner there
owns one attempt and exits with it.

**Native state is stored as written.** Entries are `json`, so a cold
resume sends the history the model cached. An append is applied with the
frames that carry it, in their transaction, so the output cursor applies
it exactly once; the attempt's runner state records it as answered,
without its entries.

## Consequences

Follow-up turns in a warm chat start at once, keep their prompt cache and
their shell, and keep MCP connections up. A warm Claude Code session holds
its CLI and MCP servers in memory while idle, hence the cap. A change to
an agent's settings applies at its next cold start, which the launch
comparison forces. Rows stored before migration 063 keep jsonb's order.
Servers get the same benefit once a sandbox runner can serve a chat's
attempts in turn, which this decision leaves for later.
