# 0205 — Machine classes: cloud servers, pooled machines, and retention

- **Status:** Accepted
- **Date:** 2026-10-06
- **Refines:** 0164, 0167, 0193

## Context

Machine rules (ADR 0167) needed a `MachineProvisioner` written in code, and
Work shipped none, so "a machine for every engineer" needed a custom server.
Dedicated servers cannot be created on demand at all. A member who left lost
their machine at once, disk included, and the reconciler kept its own lease
table (#172).

## Decision

**Classes are configuration.** `WORK_MACHINES_CONFIG` names a JSON file of
machine classes. A `hetzner-cloud` class names a server type, location and
image, and optionally SSH keys, firewalls, networks, labels, and whether to
keep a snapshot when a machine is destroyed; the API token comes from
`WORK_HETZNER_TOKEN`, never the file. A `pool` class draws on machines the
operator already enrolled. A `custom` class goes to the `machineProvisioner`
hook, which stays for other platforms. A rule naming a class the server does
not know is refused when it is written; a rule whose class later leaves the
file keeps its machines as they are. `@catamorphic/hetzner` holds the
Hetzner Cloud client and provisioner: creation is idempotent by name,
destruction finds a machine by its id or its labels, and a snapshot is
started by one call and awaited by later ones, never retried blindly (a
second one would be billed). No enrollment code is issued while machines
cannot install from the server; a platform that refuses a machine (a 4xx,
or `MachineProvisioningRefusedError` from the hook) gets its code withdrawn
so the next pass tries again. A machine stays tracked until its platform
confirms it is gone, whether or not its reference was ever recorded.

**Every machine installs the same way.** `GET /api/workers/install.sh` serves
a script that installs Docker where it is missing, installs gVisor with
Work's runtime arguments where `/dev/kvm` is missing (ADR 0204), and runs the
control plane's own image (its build bakes in the repository and release;
`WORK_WORKER_IMAGE` overrides it) with `WORK_SANDBOX=auto`, the Docker socket, `/dev/kvm` when
present, and its data directory mounted at the same path. Cloud classes pass
it to cloud-init with the machine's enrollment code; a pooled machine runs it
once: `curl -fsSL <server>/api/workers/install.sh | sudo sh -s -- --code
<code>`. The script holds no secret, checks what it downloads before using it,
waits a bounded time for another package installation (a first boot), and
never takes a system directory as the worker's data directory. The worker
container gets `/dev/kvm` and its group, never extra privileges: libkrun
needs nothing more. A server that knows no worker image or has no public
URL answers 503 saying which.

**Pools.** An operator enrolls a machine into a pool with a class label and
`"pool": true`. A pooled machine nobody holds takes no work. A rule whose
class is a pool assigns one free machine of that class to each member (or the
group's count to a group), giving it the rule's access; the machine keeps its
own labels. Each rule reports how many machines are waiting for a free one.
A group's shared machine belongs to that group: when a rule's group
changes, its machines are released, never handed to the new group.

**Retention.** When a member leaves the group, is disabled, or the rule goes,
their machine is released: it stops taking anyone's work at once and keeps
its disk for the rule's `retainDays` (default 7, recorded with the machine so
it outlives the rule), counted by the database's clock. If the member comes
back within that time, the machine is theirs again. Afterwards, once its
chats have given their workspaces back saved (they do when they idle, ADR
0173; a machine that is not connected cannot save them and does not wait),
a cloud machine is destroyed (snapshotted first when its class says so) and
a pooled machine is reset: a `machine.reset` operation has the worker
destroy every sandbox and delete members' sign-ins and volumes, and once its
receipt arrives the machine returns to the pool. A disconnected machine is
reset when it reconnects. `retainDays: 0` acts at once. A machine that
never enrolled is destroyed at once.

**The reconciler runs under a replica claim** (ADR 0193) named for the
tenant, and its lease table goes. A pass never blocks long on one machine:
a snapshot finishes on a later pass, a reset is awaited for minutes and
asked again after, and one machine's failure is recorded for its rule
without stopping the others. Writing or deleting a rule answers once it is
stored and starts a pass; the rule's status shows what failed in the latest
pass. Administrators manage rules and machines through the API
(`/api/work/machines`) with the operator's handlers.

Considered: ordering dedicated servers through Hetzner's Robot API (monthly
contracts that take hours to deliver are bought deliberately, not by a
reconciler), and keeping a released machine's disk forever (a departed
person's data would never leave).

## Consequences

A Hetzner Cloud account plus one JSON file gives every engineer a machine;
dedicated servers, on-premises machines and existing VMs join through the
same script and pools. A released machine costs money for `retainDays`.
Machines must reach the control plane's public URL and the container
registry.
