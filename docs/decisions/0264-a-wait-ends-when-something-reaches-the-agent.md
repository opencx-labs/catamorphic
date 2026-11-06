# 0264 — A wait ends when something reaches the agent

- **Status:** Accepted (refines [0240](0240-a-message-sent-while-the-agent-works-reaches-it.md) and [0155](0155-shells-background-commands-and-live-status.md))
- **Date:** 2026-10-19

## Context

ADR 0240 steers a message or task notification into the working turn, where
the harness reads it at its next step. A step does not end while a tool runs,
and some tools wait on purpose: `read_background_output` with `wait_seconds`
(up to ten minutes), `wait_for_subsessions`, a browser's `downloads` wait,
and the built-in agent's own background reads. An agent blocked in one heard
nothing until the wait ran out. In one session a watch on a pull request's
CI fired while the agent waited ten minutes on an unrelated command, and the
notification sat in the harness's queue until the person stopped the turn.
Each wait was its own loop with its own deadline, and none knew a message
had arrived.

## Decision

**One signal, fired by the engine.** Every host tool call gets
`ExtraToolContext.stopWaiting`, an `AbortSignal` the turn engine fires when
it hands the harness a steer, an interrupt or a stop (`sendCommands`), and
again when its attempt ends. It is replaced as it fires, so later calls
start fresh. The built-in AI SDK harness fires its own on every steer for
the waits inside it. It is never a cancellation: a tool that waits returns
what it has, and a tool doing work carries on.

**One way to wait.** `waitUntil` in `@catamorphic/sandbox` takes the signal
as a required argument, so a wait written with it cannot miss a message.
The desktop's background reads, the subsession wait and the downloads wait
use it, and the built-in agent's background reads honor the signal through
`followProcess`. A context without a turn (a capability call over MCP or
HTTP) passes its own request's lifetime.

**One explanation.** Core adds `STOPPED_WAITING_NOTE` to a host tool's
result when the signal fired during the call, so every tool tells the agent
the same thing: a wait ended early because something reached it, which
follows the result. The built-in agent's read says the same.

Considered: answering a waiting call early from core and leaving the tool
running, which loses what the tool would return (a background read's output
would be taken and never shown); a per-tool interruption, which is how each
wait came to forget it.

## Consequences

A message, a subagent's result or a watch's notification reaches an agent
within a poll of its arrival, however long the agent asked to wait. Waits
can be long again without risk. A new host tool that waits must use
`waitUntil` (or honor `stopWaiting` itself); one that ignores the signal
type-checks but repeats this bug. A harness's own built-in waits are its
own: Claude Code's and Codex's are inside their CLIs.
