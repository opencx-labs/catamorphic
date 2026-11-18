# 0334: Read-only caches that only a trusted fill writes

- **Status:** Accepted (amends 0208, 0257)
- **Date:** 2026-11-18
- **Refines:** 0173, 0176, 0258, 0330, 0331

## Context

An Environment whose setup has its own network keeps no volumes (ADR 0257):
the pull request's install scripts run there with a wider network and must
not poison a shared cache or read what another review left. Caches belonged
in the image, and rebuilding images per lockfile change was rejected (ADR
0208). So every review workspace installed everything from the registries: a
production pull request reviewer's first review on a new machine spent about
5 minutes installing, where a pool with prepared caches was ready in about 4
in total. Idle machines are already kept (`machines.demand.min`, ADR 0258).

## Decision

**Declaring.** An Environment may name `caches`: `{ "pnpm": { "path":
"~/.local/share/pnpm/store", "sizeMb": 8192, "fill": { "command": "pnpm
fetch", "timeoutMinutes": 30 } } }`. Names and paths follow the volume rules,
and caches and volumes never nest. `sizeMb` defaults to 10 GiB. Caches are the
project's, not an owner's, and are allowed beside a setup network. They need
the `caches` machine capability, which the container backend offers.

**Read only everywhere.** Every sandbox an Allocation of that Environment
makes (setup sandboxes on the setup network and agent sandboxes alike) mounts
the machine's copy of each cache read only. A privileged container could
remount it, so a machine that runs privileged runc containers offers no
caches, and the backend refuses one in such a sandbox. Code the
pull request controls reads a cache and never writes it.

**Only a trusted fill writes.** A fill runs the cache's `fill.command`, read
from the Environment as the published program declares it, at a published
revision of `main`: `commit` must be one Work published for the project
(ADR 0330), and by default it is the current one. No other ref is accepted,
so no pull request, session branch or draft fills. The fill gets its own
Allocation on the machine, owned by the project and charged like any work:
a fresh sandbox of the Environment's image, holding the revision's checkout
alone, on the setup's network (the Environment's own when it has none), with
no grants and no secrets but the ones `setup.secrets` names, and the cache
mounted writable as a new empty generation. On exit 0 Work checks the size
against `sizeMb`, writes `.work-cache.json` (cache, commit, fill, time) into
the cache's root, removes the sandbox (so nothing the command left running
writes later), and only then publishes the generation by marking the fill
succeeded: one row, so a sandbox sees the old generation or the new one,
never a partial one. A failed, timed out or oversized fill leaves the old
generation in place.

**Requesting.** `host["catamorphic.environments"].fillCache({ environment,
cache, commit?, idempotencyKey })` needs the new permission `caches:write`.
The caller names neither the command nor a ref, so a workflow can trigger a
fill but cannot run a command of its own with the cache writable. A project
fills on a schedule, or from its deploy workflow with its `commit` (ADR
0331). A request fills every machine holding a copy, or one placed machine
when none does.

**Where caches live: on each machine.** A copy is a Docker volume per
generation on the machine (`cache-<name>-<digest>-g<generation>`). Mounting a
generation removes the older ones no sandbox mounts. We considered one
archive in Work's storage that machines pull. It would move gigabytes
through storage seams built for small objects (the Postgres object store
included) and add a streaming transfer protocol for workers. A machine is as
close to the registries as to Work's storage, so per machine copies are the
simpler correct design. A machine with no copy mounts none: its workspace
installs from the network as before, the agent is told, and a fill for that
machine is queued. Waiting for it would hold the workspace's capacity on a
machine sized for one review, so the first workspace never waits. Machines
that `demand.min` keeps idle stay warm.

**One fill per cache and machine.** A unique index allows one running fill
per cache and machine. A request while one is queued joins it. Replicas
claim fills with `SKIP LOCKED` on the dispatch pass, and a claim that lapses
is retried with a new generation, at most 3 times. A fill that finds no room
on its machine backs off. One still queued after an hour fails.

**Staleness and cleanup.** Each copy's commit and fill time are in its
`.work-cache.json` and in the turn's note on a new workspace. Copies no
sandbox mounted for `WORK_VOLUME_RETENTION_DAYS` (30) are evicted and never
mounted again. The machine prunes their volumes on its own schedule, and a
pooled machine's reset forgets them all. `GET /projects/:id/environment-caches`
shows operators each cache's copies, sizes, last use and the last fill's
error.

## Consequences

Review machines install from a cache filled at main, using the network only
for what changed. A cache is as fresh as its last fill, and a project
decides when that runs. Local-process, microsandbox and Cloudflare machines
do not offer caches. A fill uses one workspace's capacity on its machine
while it runs.
