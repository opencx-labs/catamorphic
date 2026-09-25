# 0164 — A control plane and enrolled workers without credentials

- **Status:** Accepted; placement refined by 0167
- **Date:** 2026-09-25
- **Supersedes:** 0099's use of full server instances as execution machines
- **Refines:** 0064, 0098, 0100

## Context

ADR 0099 added execution capacity by starting more server instances against
the shared database. Every such machine held the database URL and the
deployment secret, so any one of them could read every member's credentials,
forge sign-ins, and change any record. Agent code running as a plain
subprocess on that machine could read the same secrets from its environment.
A company brain that runs code reviews and investigations on many machines
cannot give each machine the keys to everything.

## Decision

**Two roles.** The *control plane* is one or more Work server instances
sharing Postgres: API, sign-in, the vault and gateway (ADR 0162), agents'
model loops, schedules, and workflow runs. Its instances are replicas of one
trust domain. *Workers* are enrolled machines that only execute agent
sandboxes. A worker holds its own machine credential and nothing else.

**Enrollment.** An operator creates a single-use enrollment code on the
loopback operator API. The worker exchanges it once for a machine credential,
kept in an owner-only file, and afterwards dials out to the control plane over
HTTPS, so it needs no open port. Revoking a worker disables its node and its
credential immediately.

**One execution model.** A worker is an ordinary worker node (ADRs 0064, 0100)
with capacity, workspace reservations, fencing, and operator controls. The
control-plane instance a worker connects to holds that node's lease, runs its
agents' controller loops, and forwards each sandbox operation to the worker
through a lease-fenced queue in Postgres, the same operation protocol a
member's **This machine** runner uses (ADR 0098). Core lets one instance hold
several node leases. If that instance stops, the lease lapses and the worker
reconnects to another replica. Workers keep their sandboxes across
reconnects; ambiguous operations are never replayed.

**What runs where.** Environments bind to `local` (control-plane machines),
`workers` (any enrolled worker), or one node id. Workflow runs, which carry
project secrets, execute only on the control plane; workers advertise agent
workloads only. `WORK_CONTROL_PLANE_WORKLOADS` limits what the control plane
runs itself. A Postgres control plane refuses to run agent code as its own
subprocess unless it uses microsandbox or the operator explicitly opts in.

Considered: keeping peers and scoping each machine's database role. Rejected:
a peer still runs every service and holds vault and signing keys, and
per-machine database roles would not fence the vault.

## Consequences

Adding capacity no longer spreads secrets. Single-node servers are unchanged
and can add workers without adopting Postgres. Operation latency rises by one
queue hop, and workflows cannot yet run on workers; streaming workflow
supervisors to workers is follow-up work. Session placement still pins a
worker's agents to the replica holding its lease until the lease moves.
