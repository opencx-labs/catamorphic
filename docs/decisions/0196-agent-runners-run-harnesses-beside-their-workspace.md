# 0196 — Agent runners run harnesses beside their workspace

- **Status:** Accepted
- **Date:** 2026-10-02
- **Supersedes:** [0067](0067-long-lived-agent-runtimes-and-capability-gateway.md) (runtime contract), the control-loop placement in [0180](0180-harnesses-run-in-the-sandbox-models-through-the-gateway.md), the recovery half of [0095](0095-authoritative-agent-execution.md)
- **Amends:** [0174](0174-background-processes-as-a-sandbox-capability.md), [0187](0187-remote-executors-ride-out-transient-failures.md), [0190](0190-disposable-control-plane-replicas.md), [0193](0193-no-cross-replica-state-in-replica-memory.md)

## Context

A server chat's harness control loop (the Agent SDK or Codex client, tool
policy, questions) ran in one replica's memory while the CLI ran in the
sandbox, with every stdio chunk crossing Postgres. When that replica
stopped, including on every deploy, its turns failed, and recovery could
only mark them failed. Asks waited in memory, and an answer after a
restart reached nobody.

## Decision

**A runner owns one attempt.** The *agent runner* (`@catamorphic/agent-runner`)
runs a harness adapter next to the workspace it edits: inside the
session's sandbox on a server (a sandbox process from a hash-addressed
bundle, run with Bun or Node), and in-process where the harness runs on
the host (the desktop, the built-in agent). The runner knows no harness;
`@catamorphic/runner-bundle` registers the adapters a sandbox runs, so
adapters test against the real runner without a package cycle. It speaks one protocol: sequenced
NDJSON frames out (events, host calls, acknowledgements, exit) and
commands in (start, steer, interrupt, respond, stop), each command
deduplicated by id. A sandbox runner's output is addressed by byte cursor,
so any replica can read it.

**The control plane drives turns from Postgres.** A turn moves through
`queued → preparing → running ⇄ waiting → finalizing → settled`. Its
lease is renewed with every other turn the process runs, in one statement
a second, which also returns the turn's pending commands (interrupt,
steer, respond) from `agent_turn_commands`; the lease holder writes them to
the runner and marks them acknowledged when the runner says so.
Ingesting runner output commits its events and the new output cursor
together, so output is applied exactly once.

**Recovery follows the step.** Preparation (workspace, grants, anchoring)
and finalization (sync, store, checkpoint, delegation) are idempotent and
simply run again after a lost lease. A running attempt whose runner lives
in a sandbox that survived (a worker's, a member runner's) is **reattached**
by whichever replica claims the turn: it reads on from the stored cursor
and resends unacknowledged commands. A replica that stops hands such turns
back instead of interrupting them. An attempt whose runner is gone is
`lost`: its open items close, its pending requests expire as no longer
answerable, and the turn settles `interrupted`, saying what stopped. When
the provider thread has a strong native reference and the agent's
`recovery` is `continue` (the default for chats), a continuation turn is
queued once, under command id `continue:<turnId>`, telling the agent what
was interrupted, and skipped if newer work arrived. Prompts are never
silently resent.

**Asks live in the attempt.** Questions, approvals and elicitations are
runtime requests opened by the runner; the turn is `waiting`, the runner
waits, and the answer is a `respond` command any replica can deliver. A
request records whether it is still answerable. No replica polls for
answers or holds a turn open in memory, and the `parked` phase is gone.

**Host calls.** Tools the host serves (the capability gateway, desktop
workspace tools) are host calls. The lease holder runs one, recording
`tool.started` before and its result after; a call found started without a
result after a takeover answers that the host stopped while it ran and it
may have completed. Tool policy travels to the runner as data and is
decided there; only `ask` leaves it, as an approval.

**Adapters declare capabilities.** Each adapter reports what it can do
natively (steer, interrupt, retry, fork, rollback, structured questions
and approvals, subagents, streamed text, native state export) and the
strength of its ids. Core chooses the fallback by capability, never by
harness name: steer by restart, retry by resend, fork and rollback by
handoff.

**Provider threads are portable.** A provider thread's native state is
stored as entries in Postgres (`agent_provider_thread_entries`): Claude
Code through the Agent SDK's `SessionStore`, Codex by mirroring its
rollout file. Resuming in a new sandbox or on another machine
materializes them first. Where state cannot move (a store gap, an
unsupported harness, a switch of harness), the next turn records a
`context_handoff` item: an auditable, budgeted summary of the turns the
target thread has not seen, delta when returning to an earlier thread.

**Versions are checked, not assumed.** Runners, workers and member runners
state a protocol version on connect; a mismatch answers 426 naming which
side to update. Clients read the server's protocol from `GET /server`.

**Tests replay real transcripts.** Recorded provider transcripts (Claude
SDK messages, Codex app-server frames) replace only the provider transport;
the runner, adapters, turn driver, log and projections run for real.

## Consequences

Deploys and replica loss no longer fail turns on workers and member
machines. Interrupts reach a runner within a second from any replica.
Background tasks that outlive a turn remain host-owned (0155, 0174). The
built-in agent still runs on the control plane, so its attempts are lost
with their replica and continue when allowed.
