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
filesystem its sandbox provider writes to: the provider's state (the
container backend's, the local-process sandboxes, microsandbox's VMs)
and, for the container backend, Docker's data root where this process
sees it at the same path (not inside the worker's own container; there
its state, on the machine's disk, stands for it). The rest of the
machine's data folder is not measured for itself, but a stock server's
database usually shares a filesystem with its sandboxes, so that
filesystem's free space includes what the database uses; the critical
floor below is what keeps work from filling it. It reports the filesystem
with the least room above its floor as `{ path, totalBytes, freeBytes,
floorBytes, criticalBytes, measuredAt }`: a remote worker in its connect
offer and on its lease renewals, the server's own machine on its
heartbeat. The floor is `WORK_DISK_FLOOR_MB` (MiB, the same for every
filesystem; 0 keeps none), by default 10% of the filesystem and at most
10 GiB; the critical floor is `WORK_DISK_CRITICAL_MB`, by default 1% and
at most 1 GiB, never above the floor. A machine that
reports offers the machine capability `disk`. Operators see the report
and since when it is short with every machine, the server's own included
(`GET /_work/operator/machines`).

**Admission respects disk.** On a machine whose report the server heard
within 5 minutes (a report is dated by the database's clock when it
arrives, never by the machine's), a workspace is admitted only while free space less its
`storageMb` stays at or above the floor, and `storageMb` is reserved like
memory (ADR 0100): the Allocation records `reserved_storage_mb`, and the
reservations on a machine never exceed its total less its floor, which is
also the machine's `storageMb` ceiling. A workspace that does not fit
waits for room as one that does not fit by memory does; it never fails.
A workflow run is held to the critical floor instead, so the workflows
that free or replace a machine (provisioners, publishers) still run when
chats stop, and nothing starts into a truly full disk. Reservations and
the budget apply to every workload, and a cache fill reserves its cache's
size, so it starts only where that fits above its floor (on its one
machine; one that does not fit backs off, as ADR 0334 says). Placement
and admission apply the same rule.
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
images this machine pulled or built itself (a build carries its builder's
label) that none of its sandboxes was made from for
`WORK_IMAGE_RETENTION_HOURS` (24), that no container uses (Docker refuses
those) and that no other machine sharing the daemon claims, never the
machine's own default image, one it found there, or an unlabeled build.
Each machine claims an image it uses with a reference of its own
(`work.local/claims:<machine>-<hash>`) and lets go of it once unused. In
each running sandbox with containers, its Docker's dangling images and
build cache unused for as long go, never a tagged image, a container or a
volume. The machine's own daemon's build cache is not pruned: Work builds
with the classic builder, which leaves none of Work's, and a daemon shared
with other software keeps its own. Volumes keep their retention (ADR
0208); caches keep theirs (ADR 0334). In a workspace: each exec's output
folder goes once its result is recorded, and placing a program copy
removes copies of commits no exec of the workspace used within 24 hours,
nor since its oldest turn still queued or working began (a workflow hands
the path to a turn; at most a week back), nor is starting or running now; an exec names its
commit as it starts, and a copy used again is touched, its time being
what counts for a copy Work has no record of (ADR 0324). Nothing of the project's own
(the checkout, its volumes, its caches, its tagged images) is removed.

**Out of disk is a reason.** When a turn fails, a workflow run fails, an
exec ends with a failure, or a cache fill fails while the machine reports
free space under its floor, the error says so with the machine's numbers:
the turn's error kind is `out_of_disk`, and the attempt's diagnostics
(ADR 0333) carry the same line. A turn failure that already has a kind
(a provider's limit or outage, a lost sign-in, a missing agent, a history
to repair) keeps it, with the actions that come with it. Output that says `ENOSPC` or `No space
left on device` gets the same reason with "the workspace ran out of disk
space" and the machine's numbers: that text can come from code the chat
runs, so it explains a failure but never acts on the machine.

**One event per episode.** The control plane records a machine's episode
when a report first shows free space under the floor (`disk_low_at`, one
conditional update), and ends it when free space is back above 1.1 times
the floor. A machine of a `workflow` class (ADR 0327) then records the
project event `machine.disk-low` (source `machines`) with its name, class,
rule, ref and the report, once per episode, so a workflow can alert or
size later machines. A recording that fails is tried again on each later report of
the episode until it lands; the event's id names the episode, so it is
recorded once. Only Work's own measurement starts an episode. Replacing a machine is
Work's: on demand, a machine short of disk takes no new work, still
counts toward the rule's `max` (a hard ceiling, so code that fills disks
cannot drive the machine count) and `min`, and is destroyed once it holds
no work, so no review is cut off; only then does its place open. A rule
whose machine came up under its floor within 30 minutes of enrolling has
a class whose disk is too small for its work: it makes no new machines for
an hour after the latest such machine, or until it is written again, and
says so in its status, and a workflow class's project hears
`machine.disk-too-small` once per brake, so machines are never made and
destroyed in a loop. Policy stays in the project: the
`machines-ec2` recipe documents root volume sizes. A workflow that
terminated the machine on the event was considered and left out: it could
not see whether the machine was still short or still working.

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
