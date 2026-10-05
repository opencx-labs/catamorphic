# 0204 — Machine classes: cloud servers, pooled machines, and retention

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
not know is refused when it is written. `@catamorphic/hetzner` holds the
Hetzner Cloud client and provisioner: creation is idempotent by name, and
destruction finds a machine by its id or its labels.

**Every machine installs the same way.** `GET /api/workers/install.sh` serves
a script that installs Docker where it is missing, installs gVisor with
Work's runtime arguments where `/dev/kvm` is missing (ADR 0203), and runs the
control plane's own release of the worker image (`WORK_WORKER_IMAGE`
overrides it) with `WORK_SANDBOX=auto`, the Docker socket, `/dev/kvm` when
present, and its data directory mounted at the same path. Cloud classes pass
it to cloud-init with the machine's enrollment code; a pooled machine runs it
once: `curl -fsSL <server>/api/workers/install.sh | sudo sh -s -- --code
<code>`. The script holds no secret.

**Pools.** An operator enrolls a machine into a pool with a class label and
`"pool": true`. A pooled machine nobody holds takes no work. A rule whose
class is a pool assigns one free machine of that class to each member (or the
group's count to a group), and the reconciler reports when none is free.

**Retention.** When a member leaves the group, is disabled, or the rule goes,
their machine is released: it stops taking anyone's work at once and keeps
its disk for the rule's `retainDays` (default 7). If the member comes back
within that time, the machine is theirs again. Afterwards a cloud machine is
destroyed (snapshotted first when its class says so) and a pooled machine is
reset: the worker destroys every sandbox and deletes members' sign-ins and
volumes, and the machine returns to the pool. `retainDays: 0` acts at once.

**The reconciler runs under a replica claim** (ADR 0193) and its lease table
goes. Administrators manage rules and machines through the API as the
operator does through the loopback listener.

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
