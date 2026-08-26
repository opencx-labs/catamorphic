# ADR 0069: Host-owned processes, watches, wakeups, and schedules

- **Status:** Accepted
- **Date:** 2026-08-24
- **Builds on:** 0006, 0024, 0067, 0068

## Context

Harnesses can start background commands, but Catamorphic currently infers
their liveness from provider events or command text. Provider-private timers
and schedules cannot support consistent remote execution, ownership, audit,
or host UI.

## Decision

An Allocation owns normalized processes and PTYs. The host exposes start,
list, inspect, read, write, stop, and attach capabilities. Terminal tabs are
views of process ids. Provider tasks and subagents remain distinct but map to a
shared activity presentation.

Watches are host-owned conditions over process output or exit, files, ports,
HTTP, git, CodeHost PR or CI state, and host-defined external sources. They
survive turns, have explicit owner and expiry, and may wake an agent or
workflow control path.

Durable schedules and one-shot wakeups live in Postgres and dispatch through
the existing queue. A durable schedule targets a committed workflow
enablement, including a member-owned enablement. Local personal schedules live
in desktop profile state, use current personal files, run only while the
desktop is online, and cannot target a remote Environment.

Canonical process, Watch, schedule, and wake capabilities are registered in
the unified gateway. Harness-private schedule state is not Catamorphic product
state.

## Consequences

Hosts can render and control authoritative activity across harnesses and
execution locations. Remote scheduling has explicit code revision, owner,
connections, and suspension semantics. Durable workflow recovery still relies
on persisted boundaries rather than assuming an OS process survived a runner
failure.
