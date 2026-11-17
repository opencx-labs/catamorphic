# 0327 — Machine provisioners are workflows

- **Status:** Accepted (refines 0205, 0258)
- **Date:** 2026-11-17

## Context

Machine classes (ADR 0205) create machines on Hetzner Cloud, draw on pools,
or call the `machineProvisioner` hook, which is host server code. A team on
AWS had to fork the server or build the lifecycle outside Work: the opencx
reviewer did, with about 1,500 lines of EC2 code plus IAM for launch
intent, idempotency tokens, heartbeat replacement, idle stop and orphan
sweeps. Work already owns the hard part (demand, replacement after
`enrollMinutes`, draining under the node lock, destroying until done). What
was missing is a way to say "this is how a machine is made" as ordinary
project code an agent can write.

## Decision

**A `workflow` class names a project and two of its workflows.**
`{ "platform": "workflow", "project": "<project id>", "create": "<export>",
"destroy": "<export>", "options"?: {...}, "sandbox"?: ... }` in
`WORK_MACHINES_CONFIG`. The workflows bind the server's `machine.create` and
`machine.destroy` trigger kinds and are turned on **for the project** (ADR
0156): the reconciler dispatches to that project enablement only, at its
commit, in its Environment, with its consented connections and declared
secrets, as the project principal. A member's enablement of the same
workflow is never used. With none on, creation is refused with a message
saying which workflow to turn on, and the rule's status shows it. Workflow
runs stay on the control plane (worker machines take only agents), so a
provisioner never waits for a machine it makes.

**Create gets what the hook gets.** The run's input is the hook's `create`
argument: `name`, `class`, `rule`, `options`, `waiting` (what the waiting
work needs), `labels`, and `enrollment` (`controlPlaneUrl`, `code`,
`idempotencyKey`, `cloudInit`). It returns `{ ref }`, or `{ refused }` when
the platform created nothing. `destroy` gets `{ name, class, rule, ref,
options }` (`ref` null when none is known) and returns `{ done }`. Both
output shapes are part of the trigger kinds, so a workflow that returns
anything else fails its check.

**Intent is persisted before the run starts, and a pass never waits for
one.** Before starting `create`, the reconciler records the provisional ref
`creating:<idempotencyKey>` on the enrollment, then starts the run under the
correlation key `machine-create:<idempotencyKey>`. Later passes read the
latest run with that key, the way a Hetzner snapshot is started once and
awaited (ADR 0205):

| Run | Reconciler |
|-----|------------|
| pending, running, waiting | the machine stays pending |
| `{ ref }` | the ref replaces the provisional one (on the worker too, if it enrolled first) |
| `{ refused }` | a refused create: the code is withdrawn (as `MachineProvisioningRefusedError`) |
| failed, canceled, other output, or no run after a start that failed uncertainly | an uncertain create: the code stays, the failure shows in the rule's status, and a machine that never enrolls expires and is destroyed by name |

A create is never started twice for one enrollment: the key is checked
before every start, under the reconciler's claim.

**Destroy is asked until done.** A pass starts `destroy` under
`machine-destroy:<name>:<ref>` unless a run with that key is active; a run
that answered `{ done: true }` forgets the machine; `{ done: false }`, a
failure, or no run starts another on the next pass. While the machine's
create run is still active, destroy waits for it, so a destroy right after
a create never misses the machine the create is making.

**Machines report their lifecycle to the provisioner's project.** For a
`workflow` class, the server records Project Events (source `machines`):
`machine.created` (its ref recorded), `machine.connected` (first contact),
`machine.lost` (a machine on demand unseen for `enrollMinutes`),
`machine.released`, and `machine.destroyed`, each with `name`, `class`,
`rule` and `ref`, once per machine and kind. Workflows trigger on them like
any project event, for bookkeeping, alerts, or cost records in project
code.

**The hook stays** for hosts that prefer server code; both build the same
request, and the hook keeps answering in place. Work ships no cloud SDK:
the `machines-ec2` registry pack (ADR 0262) is the EC2 recipe, with
`RunInstances` under a `ClientToken` derived from the idempotency key,
tag-scoped IAM, IMDSv2, on-demand or Spot, and a destroy that answers done
only once the instance is terminated or gone.

Considered: a provisioner as an agent capability or host call (still server
code); project events in both directions (the reconciler would read
outcomes from delivery receipts, and several bound workflows would answer
one create); a cloud autoscaling group (ADR 0258 rejected it).

## Consequences

A company on AWS, GCP or a private cloud writes two workflows instead of a
server. The enrollment code is in the create run's input, so whoever reads
that project's runs can see it until it is used or expires: keep the
provisioner in a project only administrators reach. A create run that
fails uncertainly holds its machine's name until `enrollMinutes` pass.
