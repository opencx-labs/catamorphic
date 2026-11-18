# 0335: Disk is a resource Work manages on machines

- **Status:** Accepted (amends 0100, 0204, 0208, 0324, 0327, 0333)
- **Date:** 2026-11-18

## Context

A production pull request reviewer's busiest pull request stopped getting
reviews: every push left a checkout with its dependencies on the machine,
nothing removed them, the disk filled, and every later step failed with
`ENOSPC`. The author saw only that the runner exited during preparation.
A Work review machine hosts many workspaces, each with its dependencies,
an overlay over the cache and, with `containers`, its own Docker data, so
one busy pull request filling the disk would break every review there.
Work admitted workspaces by CPU and memory only: the container backend
refused `storageMb`, nothing checked free space, and Work's own leftovers
(one `.work-program/<commit>` per main commit per workspace, every exec's
output files, Environment images and build cache) grew without end.

## Decision

**Machines report disk.** A machine measures, every 30 seconds, each
filesystem Work writes to: its data folder (the provider's state, the
local-process sandboxes, microsandbox's VMs) and, for the container
backend, Docker's data root where this process sees it at the same path
(not inside the worker's own container; there its data folder, on the
machine's disk, stands for it). It reports the filesystem with the least
room above its floor as `{ path, totalBytes, freeBytes, floorBytes,
measuredAt }`: a remote worker in its connect offer and on its lease
renewals, the server's own machine on its heartbeat. The floor is
`WORK_DISK_FLOOR_MB` (MiB, the same for every filesystem; 0 keeps none),
by default 10% of the filesystem and at most 10 GiB. A machine that
reports offers the machine capability `disk`. Operators see the report
with the machine.

**Admission respects disk.** On a machine with a report younger than 5
minutes, a workspace is admitted only while free space less its
`storageMb` stays at or above the floor, and `storageMb` is reserved like
memory (ADR 0100): the Allocation records `reserved_storage_mb`, and the
reservations on a machine never exceed its total less its floor, which is
also the machine's `storageMb` ceiling. A workspace that does not fit
waits for room as one that does not fit by memory does; it never fails.
Machines on demand count a machine under its floor as having no room, so
waiting work gets a new machine (ADR 0258). An Environment's `storageMb`
needs a machine that enforces it (microsandbox, which sizes its VM's root
disk) or reports disk; only an enforcing provider is given it. The
container backend cannot enforce it: the workspace is a Docker volume,
and Docker caps a container's own layer only on some storage drivers, never a
volume. There it is reserved and the machine measured, not enforced:
one workspace can still use more than it reserved, and the floor, not the
reservation, then protects the others.

**Work removes what Work leaves.** On the machine, hourly and at once when
a report falls under the floor (at most every 10 minutes): Environment
images Work built or pulled that no sandbox was made from for
`WORK_IMAGE_RETENTION_HOURS` (24) and that no container uses (Docker
refuses those), except the machine's own default image; Docker build
cache unused for as long; and in each running sandbox with containers,
its Docker's dangling images and build cache unused for as long, never a
tagged image, a container or a volume. Volumes keep their retention (ADR
0208); caches keep theirs (ADR 0334). In a workspace: each exec's output
folder goes once its result is recorded, and placing a program copy
removes copies of commits no exec of the workspace used within 24 hours,
nor since its oldest turn still queued or working began (a workflow hands
the path to a turn), nor is starting or running now; an exec names its
commit as it starts, and a copy used again is touched, its time being
what counts for a copy Work has no record of (ADR 0324). Nothing of the project's own
(the checkout, its volumes, its caches, its tagged images) is removed.

**Out of disk is a reason.** When a turn fails, a workflow run fails, an
exec ends with a failure, or a cache fill fails while the machine reports
free space under its floor, the error says so with the machine's numbers:
the turn's error kind is `out_of_disk`, and the attempt's diagnostics
(ADR 0333) carry the same line. Output that says `ENOSPC` or `No space
left on device` gets the same reason with "the workspace ran out of disk
space" and the machine's numbers: that text can come from code the chat
runs, so it explains a failure but never acts on the machine.

**One event per episode.** The control plane records a machine's episode
when a report first shows free space under the floor (`disk_low_at`, one
conditional update), and ends it when free space is back above 1.1 times
the floor. A machine of a `workflow` class (ADR 0327) then records the
project event `machine.disk-low` (source `machines`) with its name, class,
rule, ref and the report, once per episode, so a workflow can replace or
grow it. Only Work's own measurement starts an episode. Policy stays in
the project: the `machines-ec2` recipe documents root volume sizes and
ships an optional workflow that terminates a machine on `machine.disk-low`,
which Work then replaces on demand.

Considered: per-sandbox quotas (Docker cannot cap a volume; out of scope);
failing a workspace that does not fit (a full machine is a wait, like
memory); counting reservations against measured free space (free space
already includes what admitted workspaces used, so it would count them
twice); trusting `ENOSPC` in output to start an episode (code the pull
request controls could then make Work replace machines).

## Consequences

A machine filling up stops taking work before it breaks what runs there,
names the cause in each failure, and tells its project once. `storageMb`
is a reservation on the container backend and local-process, and a limit
on microsandbox. Images are rebuilt or pulled again after a day without
use. Free space is up to 30 seconds old at admission, and workspaces
admitted together share one measurement: the floor is the margin for
both. Member machines (client runners) and the desktop report no
disk and are unchanged.
