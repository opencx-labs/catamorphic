# 0062 — Session privacy and the fork's UX: incognito, policy, usage

Status: Accepted (2026-08-21)

## Context

ADR 0061 made mirroring default-on and forks server-owned. Four nuances
followed (from the product owner): the abandoned copy must SAY it was
continued elsewhere and point at the fork; the fork should run the same
agent when the server has it; default-on sync needs a privacy escape
valve; and teams need the opposite — everything synced, usage visible to
admins.

## Decision

**Fork UX.** On the first `409 diverged`, the desktop stamps its local
copy with a system row — *"Continued on <host> — this copy is history
now."* — carrying a `mirror_fork` marker (`serverUrl`,
`remoteProjectId`, `sessionId`). Idempotent: one marker per session.
Clients honor it: the PWA locks the composer on a forked copy and shows
"Open the live conversation" (when a connection to that server exists),
routing to the same session id on the remote. Interaction happens only
on the fork.

**Same agent across the fork.** The mirror payload carries the source
session's PROJECT-agent slug (`project:<id>:<slug>` sessions only —
those definitions are committed files that sync between backends). The
receiving side uses `project:<its-id>:<slug>` when its registry has it
AND the caller's scope covers it; otherwise the registry default.
Personal/host agents never cross — they are not project artifacts.

**Incognito sessions (`agent_sessions.incognito`, migration 050).**
A per-session flag set at create (`incognito: true` through the whole
stack: route → hooks → desktop palette "New incognito chat", Ghost
badge on the dock and in the PWA list). An incognito chat persists
locally like any other but is **never mirrored** — it stays off the
server, out of team history, out of usage. Default remains synced.

**Project policy.** `.catamorphic/project.json` `"allowIncognito":
false` disables the affordance for a project's members (palette entry
hidden, handler no-ops). This is committed, code-reviewed policy honored
by clients — mirroring is a client push, so it is policy, not
cryptography; a team requires compliant clients, same as any endpoint
rule.

**Usage for admins.** `GET /admin/usage` on the stock server rolls up
the per-turn usage every assistant message already carries in its
metadata (ADR 0057) — mirrored desktop turns included, since the
metadata rides the mirror. Per member × project: sessions, turns,
input/cached/output tokens, cost, last activity. Incognito sessions
never arrive, which is exactly their contract — that's the
privacy-aware line: teams that want full accounting disable incognito;
individuals who need a private thought keep one.

## Consequences

- The desktop's own composer does NOT yet lock on a forked session (the
  hint row shows; continuing locally creates a parallel local branch).
  Desktop-side locking mirrors the PWA treatment and is follow-up work.
- Usage numbers are as honest as the harnesses' reporting
  (`metadata.usage`); turns without usage still count as turns.
- Coverage: pusher tests (incognito skip, agent-slug carry, fork-marker
  stamp), stock-server tests (usage rollup incl. mirrored turns), PWA
  fork-notice parsing, migration exercised by the PGlite suite.
