# 0100: Workspace resource admission

- **Status:** Accepted
- **Date:** 2026-09-07

## Context

Remote development can leave servers and build processes running between agent
turns. Checking node liveness or limiting model turns does not bound those
resources. Existing agent Environment requirements were not passed to providers.

## Decision

A managed Allocation reserves one workspace slot and its CPU/memory budget in
Postgres before admission. Node row locks serialize reservations across server
instances. Each Allocation owns at most one sandbox, including workflow child
invocations. Existing placements remain pinned; new admissions skip full nodes.
Capacity exhaustion is an explicit retryable admission error.

Reservations last as long as the workspace, including idle development sessions.
Closing, archiving, moving, or finishing a workflow retires the workspace. The
owning node destroys its sandbox before returning capacity. Missing heartbeats
alone never prove that resources have stopped. Failed cleanup retains capacity.

Per-agent resource requirements become provider-enforced sandbox limits. Providers
advertise supported limits and reject unsupported requests. Stock servers can use
microsandbox for isolated remote development. Trusted local-process execution
retains its explicit single-tenant boundary and supports workspace slots, not
CPU/memory isolation. Hosts inject their providers and machine budgets.

## Consequences

A chat with a live workspace consumes capacity between turns. Archiving it frees
resources after cleanup; restoring it requires fresh admission. This deliberate
reservation supports development servers without oversubscribing the machine.
Provisioners leave host headroom and configure budgets, sandbox images, and agent
requirements. Library policy remains independent of stock provisioning or UI.
