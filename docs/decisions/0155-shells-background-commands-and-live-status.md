# 0155 — Native shells, host background commands, and the agent's live status

- **Status:** Accepted
- **Date:** 2026-09-23
- **Refines:** 0069, 0074, 0101, 0133

## Context

Foreground commands already ran on each harness's own shell (0101, 0133), but
long-running work had no good home. Claude Code's native backgrounding lives
inside the per-turn CLI process: a dev server either kept the turn "working" or
died when the turn closed, and nothing told the agent when a build finished.
Codex had no background tools at all, so the harness guessed at daemonized
commands with a regular expression. The built-in agent's shell forgot `cd`
between calls, kept only the head of long output, and could not be cancelled.
Terminal tools (`run_terminal`, `read_terminal`) duplicated a shell with worse
semantics. The chat's live line said "Working..." while the agent had written
perfectly good words about what it was doing.

## Decision

**Shells stay native.** Claude Code's Bash and Codex's exec run foreground
commands. The built-in agent's `bash` matches them: the working directory
persists, timeouts run up to ten minutes, output keeps its start and end, and a
timeout or cancelled turn stops the whole process group.

**Long-running work is a host background command**, the same for every
harness: `run_background_command` (command, description, `wake_on_exit`,
`wake_on_output`), `read_background_output` (new output since the last read,
optionally blocking) and `stop_background_command`. Each one runs in its own
agent terminal: a chip the person can open, alive past the turn, owned by the
chat and stopped when the chat is archived. When it finishes, or prints a line
matching `wake_on_output`, the host delivers a `next_turn` system message to
the chat: the agent reads the outcome and output tail, and the person sees one
quiet notice. Claude Code's native backgrounding and its follow and stop tools
are switched off when the host owns background commands. The Codex daemon
heuristic, the `background` agent event and the terminal-run tools are removed.
`write_terminal` remains for interactive input, and `read_tab` reads any
terminal.

**The live line is the agent's own words.** A new `status` agent event carries
a harness's summary of what the agent is doing: the bold heading of a Codex or
OpenAI reasoning summary. Command and tool events carry a `description` when
the agent wrote one (Claude Code's Bash description, host tools' `description`
argument), and host todos gain `activeForm`, shown while an item is in
progress. Core keeps the latest of these per turn as the activity line; generic
labels apply only while the agent has said nothing.

**The chat shows it.** Command steps lead with their description. A background
step reads "Running in background" and pulses, outside the folded steps,
until its process ends; then it reads "Ran command in background" and folds in.
The step is paired with its process by command text and description, in start
order.

## Consequences

Every harness gets the same background mechanism without changing its
native shell. Session watchers (0074, 0076) remain the tool for schedules and
external events; background commands cover processes the agent started. Three
eager tools raise the eager schema budget to 7 KB. Terminal offsets are now
absolute character counts, so reads stay exact through buffer shedding.
Background commands run on the desktop host; sandboxed topologies need an
equivalent provider capability before they can offer them.
