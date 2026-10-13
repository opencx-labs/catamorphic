# 0223 — An agent terminal lives as long as its command

- **Status:** Accepted (amends [0155](0155-shells-background-commands-and-live-status.md); bash marks its commands and a guessed end must last, amended by [0226](0226-agent-terminals-mark-commands-in-bash-too.md))
- **Date:** 2026-10-12

## Context

0155 gave each background command its own agent terminal, "alive past the
turn, owned by the chat and stopped when the chat is archived". In use, a
chat collected a chip for every command it had ever run, each an idle
login shell. Chips kept spinning after their command was stopped: every
way main ended a terminal deleted it without saying it was no longer busy,
and the renderer only cleared the spinner when told. Chips whose terminal
was gone could come back as a plain "Terminal" chip from a stale
attention mark, and main counted every idle agent shell as active work.

## Decision

**An agent terminal ends with its command.** When a background command
finishes or is stopped, its shell ends and its chip leaves the chat. The
chat's background step and its notice stay, and the agent still reads the
command's final output. A terminal the person has open as a tab keeps
showing that output until they close it; closing it then removes it.

**A terminal is active only while a process runs in it.** Every way a
terminal ends (exit, stop, close, kill) clears its activity, and the
renderer handles an agent terminal's end itself, whether or not its tab
was ever mounted. Main counts a terminal as active work only while a
command runs in it.

Keeping finished terminals as quiet chips until the next turn, or until
the person dismisses them, was considered: either still leaves the chat to
fill up, and the step and notice already record what ran.

## Consequences

A chat's chips show what is running now. A command the person wants to
follow after it ended is read from its step and notice, or by asking the
agent, not from a live shell. Reopening a closed agent terminal (Cmd+Shift+T)
is no longer offered: its process is gone.
