# 0174 — Background processes are a sandbox capability

- **Status:** Accepted (amended by [0196](0196-agent-runners-run-harnesses-beside-their-workspace.md))
- **Date:** 2026-09-27
- **Refines:** 0155, 0164

## Context

Server-side agents could not keep a dev server, database or watcher running
while they worked, and could not run anything longer than ten minutes. ADR
0155 gave desktop agents background commands, but those run as host terminals
next to the user's own shell. A sandbox had no equivalent. Operations to a
remote worker or a member's **This machine** are request/response jobs in
Postgres (ADR 0164) that expire after minutes, so one long `executeCommand`
could not carry a long test suite either.

## Decision

**Processes belong to the sandbox.** `SandboxProvider` gains an optional
`processes` capability: `startProcess({ sandboxId, command, cwd?, env?, name? })`,
`readProcessOutput({ sandboxId, processId, cursor?, maxBytes?, waitMs? })`,
`signalProcess({ sandboxId, processId, signal })` and `listProcesses({ sandboxId })`.
Combined output stays inside the sandbox, addressed by byte cursors. A read
returns the chunk, `nextCursor`, `more`, the status and exit code, and can
block up to 20 seconds for news. Every operation is short, so the worker and
member-runner queues carry them unchanged as `process.*` operations, and no
streaming transport is needed. Signals reach the process's whole group.
When a command ends, what it left running in its group is stopped. Processes
die with their sandbox: stopping or destroying it ends them.

**Implementations.** local-process spawns each process in its own group,
writing to a log beside the workspace. microsandbox uses
`shellSandboxProcesses`, built only on `executeCommand`. It keeps state
in a directory inside the VM and starts each process in its own session. A
worker's offer and a member runner's registration say whether their provider
runs processes (`client_runners.processes`, migration 030), and the
control-plane forwarder offers them only then. Allocation guards, fencing and
OpenTelemetry spans (`sandbox.process.*`) wrap it like every other operation.
Cloudflare and Daytona do not advertise it until someone checks that detached
processes survive their exec APIs. The shell implementation makes adding them
cheap.

**One agent vocabulary.** The built-in harness offers the ADR 0155 tools
wherever its sandbox has `processes`: `run_background_command`,
`read_background_output` (with `wait_seconds` and a `wait_for` line pattern)
and `stop_background_command`. A foreground `bash` command is a process the
tool waits on. Its ceiling is the Environment's
`requirements.resources.commandTimeoutSeconds`, renamed from the
ambiguous `timeoutSeconds`, which already capped sandbox commands. Without
a budget the ceiling stays ten minutes. A command that runs out of time or
is cancelled stops with its group. Closing a chat disposes its harness session,
which kills its background commands before the Allocation's sandbox is
destroyed. We kept these names instead of Claude Code's `run_in_background`,
`BashOutput` and `KillShell`, because Work already switches those off for
the host's tools. Agents on the desktop and on the server see one surface.

**The desktop keeps host background commands.** They serve a different
purpose: every harness, including Claude Code and Codex on the user's own
checkout, runs them in a terminal the person can open, and they wake the chat
when they finish. The desktop's built-in harness works on the native checkout
without a sandbox, so it uses those host tools. Its `read_background_output`
gains the same `wait_for`. Rebuilding the terminals on sandbox processes would
lose the visible terminal and gain nothing.

## Consequences

A server-side agent can start a dev server, run a long test suite against it,
read its logs and stop it, on the control plane or on a worker. Following a
process costs one queue operation per read, and a read blocks for at most
20 seconds. Output lives in the sandbox and counts against its storage. Server
background commands do not wake a chat when they finish yet; the agent waits
with `read_background_output`. Waking needs a control-plane watcher and is
follow-up work, as are Cloudflare and Daytona support.
