# 0263 — Resources lists what Work runs, by who it runs for

- **Status:** Accepted (builds on [0102](0102-tabbed-sidebars-and-app-widgets.md), [0140](0140-local-agent-freedom-and-executable-sidebar-sources.md), [0234](0234-sidebar-sections-are-sources.md))
- **Date:** 2026-10-19

## Context

Work starts many processes: its own Electron processes, a renderer per
browser tab, a shell per terminal, a Claude Code or Codex CLI per chat
(kept warm between turns, ADR 0222), the commands agents run, and a Bun
process per sidebar module. When the machine slows down, Activity Monitor
shows a dozen rows named `node`, `bun`, `claude` and `Work Helper
(Renderer)`, and nothing says which chat, tab or terminal each one is for.
Work knows, and nothing showed it.

## Decision

**`work:resources` is one of Work's lists.** Its rows are owners: a Total
row, Work itself (main process, graphics, utilities, its windows,
extensions, and children nobody else claims), then each chat, terminal,
browser tab and sidebar module that has processes. An owner's processes
are its children, its root processes first, each followed by its own
descendants. Rows read CPU (percent of one core, as Activity Monitor does)
and resident memory. A section shows it like any other list
(`source: "work:resources"`); no default layout includes it.

**Rows grow a `trend`.** `trend: { values, label?, tone? }` is the recent
history of a value from 0 to 1, oldest first, drawn as a small line and area
at the row's end with its current reading beside it. Resources uses it for
CPU, so every row is a sparkline; any source may use it.

**The main process samples only when asked.** A read returns one snapshot:
`app.getAppMetrics()` for Electron's processes, and one `ps` (macOS) or
`/proc` (Linux) pass for the process tree under Work's main process, CPU
taken from the change in CPU time since the previous sample. Snapshots are
shared for a second and keep thirty samples of history per process and
owner. Nothing samples while no section reading the list is shown: the
list polls every two seconds only while subscribed. Windows lists only
Electron's processes for now.

**Owners come from what started each process.** Webcontents give a window
or a browser tab (the window maps a guest to its tab); the terminal manager
registers each local shell's pid (an agent's terminal belongs to its
chat); a sidebar module's worker registers its pid. A harness CLI is
recognized by `CATAMORPHIC_SESSION_ID`, which `AttemptRunner` adds to every
attempt's environment: harnesses pass their environment to what they run,
so the commands an agent starts carry it too. The variable is only a
label; nothing authorizes on it. Descendants belong to their nearest
owned ancestor.

**Ending goes through the owner.** A terminal closes as its tab does, a
browser tab closes, and a chat's or module's processes end. Ending a
process sends SIGTERM to it and its descendants, and SIGKILL to those
still running three seconds later. Main checks the pid against its last
snapshot and refuses Work's own processes and windows. Ending a chat's
harness mid-turn ends that turn as a harness exit does; the next turn
starts a fresh one.

Considered: an app widget (apps are sandboxed and placement grants no
authority, ADR 0102); a sidebar module over `ps` (it could not know owners
or webcontents); attributing harnesses by working directory (chats share
folders); `pidusage` (one more dependency for what `ps` and `/proc` give).

## Consequences

Any layout can add a Resources section and an agent can read it through
`work.read`. Every harness process now carries its session id in its
environment. Processes that leave Work's tree (a daemonized server) are
not listed. Linux reads `/proc` for every process each sample, which costs
a few milliseconds while the section is shown.
