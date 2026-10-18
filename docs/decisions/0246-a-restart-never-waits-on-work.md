# 0246 — A restart never waits on work

- **Status:** Accepted (amends 0083 and 0198)
- **Date:** 2026-10-18

## Context

ADR 0083 kept Work from restarting into an update while an agent or a
terminal was working. A person who keeps agents busy all day could not
update at all: Restart stayed disabled, and pressing it while the alert
still offered it answered "Finish active agents and terminals before
restarting" again and again. Work also forgot the download when it quit
for any other reason, so the next launch offered "Download update" for a
release already on disk.

ADR 0198 already continues a turn whose runner went away with its holder:
the turn settles interrupted, and a continuation turn tells the agent to
carry on, checking what was already done. Only a crash took that path. A
clean quit interrupted every turn, and nothing continued it.

## Decision

**A restart is never blocked.** Installing an update and moving Work into
Applications relaunch it at once, whatever is running. Their shutdown
first hands every turn back (`Catamorphic#handBackTurns()`, which stops the
agent worker and calls `stopLocalTurns({ handBack: "all" })`) before
anything a turn uses stops. A handed back turn is not interrupted: its
lease is released, its in-process runner ends with Work, and the next
launch claims it, finds its runner gone and continues it, exactly as after
a crash. A turn that was finalizing settles before Work quits. Terminals,
previews and background commands simply end. An ordinary quit is
unchanged: it still interrupts working agents.

**A downloaded release is remembered.** `<userData>/updates.json` keeps the
version downloaded beside the channel. A check that finds that version
again has electron-updater verify its cached copy (or fetch it again)
without asking, and the alert offers Restart, never Download. Running that
version forgets it.

The alert says what a restart does while work runs: working agents pick
up where they left off, and open terminals close.

Considered: interrupting turns and queueing a continuation once each
settled, which needs the harness to settle within the quit's few seconds
and a second continuation path beside ADR 0198's; continuing turns after
every quit, which would start agents again when the person closed Work to
stop them.

## Consequences

People update while agents work. A continued turn reads as interrupted,
followed by the agent carrying on, as after a crash; work a tool was
doing as Work quit is checked again by the agent rather than repeated
blindly. A harness without a strong thread reference (or an agent whose
recovery is `stop`) is not continued: its turn ends interrupted, as before.
Hosts that restart themselves can call `handBackTurns()` too.
