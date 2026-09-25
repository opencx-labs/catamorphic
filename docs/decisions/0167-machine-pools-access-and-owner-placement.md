# 0167 — Machine pools, node access, and placement by owner

- **Status:** Accepted
- **Date:** 2026-09-25
- **Refines:** 0064, 0070, 0098, 0164, 0166

## Context

An Environment's `binding` answered two questions at once: what the work
needs and where it runs. `local`, `workers`, and node ids made the project
name machines, so giving each employee their own machine would mean an
Environment per person in every project. Placement was first-fit and ignored
whose work it was: a `workers` Environment could put one person's agent on
another person's machine.

## Decision

**Environments state needs; the deployment decides where.** A project
Environment declares its workloads, requirements (trust, isolation,
capabilities, resources), and an optional `pool`: node labels that must all
match. `binding` is gone. `device: "member"` replaces `this-machine` for a
member's own connected computer (ADR 0098). The default Environment is named
`default` and selects nothing, so it runs wherever the host places work.

**Nodes carry labels.** Hosts label every node, control-plane nodes
included. The Work server adds `node` (its id) and `plane` (`control` or
`worker`); operators add their own (`pool`, `class`, and so on). Workflow
runs stay on the control plane because only control nodes offer the
`workflow` workload, not because of a special case.

**Access says whose work a node takes.** Each Work server worker has an
access list of people, directory groups, or everyone, set by the operator at
enrollment. It is control-plane state: a worker never declares it. A worker
that serves more than one person must isolate with microsandbox unless the
operator marks it trusted.

**Placement follows the owner.** `EnvironmentProvider.get` receives the
owner of the work (the session owner; none for project chats and runs) and
the pool. The narrowest node open to the owner wins: their own machine, then
a group's, then a shared pool. When that tier is full, placement falls back
to broader ones unless the Environment is `strict`. An Allocation keeps its
node; re-resolving it re-checks the node's labels and access, so a revoked
person's agents stop on the next turn.

**Machines follow the directory.** Operators write machine rules: every
active member of a group gets a dedicated machine of a class, or a group
shares a fixed number. A `MachineProvisioner` hook creates and destroys
machines on a platform, passing each a one-time enrollment code. A reconciler
compares rules and active accounts with enrolled workers and creates,
revokes, and destroys to match. A person disabled in the directory loses
their dedicated machine on the next pass.

Considered: named per-person Environments. Rejected: every project would have
to know every employee, and access would still be unchecked.

## Consequences

"A machine per employee" is one rule, and shared machines use the same path.
Group-based access needs the groups in the directory mirror, so groups named
by worker access or machine rules are checked like groups mapped to roles.
The worker credential is still a static bearer and operations are still
request and response, not streamed; rotation and streaming (which also lets
workflows run on workers) remain follow-up work.
