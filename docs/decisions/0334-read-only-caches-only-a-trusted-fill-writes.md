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
caches, and the backend refuses one in such a sandbox. Under runc without
privileges the kernel refuses root a remount. Under gVisor a review sandbox
with its own Docker holds every capability, and gVisor accepts the remount
in its own mount table, but runsc opened the read-only mount read only on
the host, so every write still fails (`EROFS`); a test proves both. Code the
pull request controls reads a cache and never writes it. Placement is not the
only guard: the Allocation's wrappers, the executor on the machine, and the
local-process and microsandbox backends all refuse a cache on a provider that
does not offer `caches`, since it would mount it writable.

**Only a trusted fill writes.** A fill runs at a revision of `main` that
went live through the deploy gate (ADR 0331): `commit` must be a published
revision whose status is `applied` (ADR 0330), and by default it is the
latest such. A pending, deploying, failed or superseded revision is refused,
and no other ref is accepted, so no pull request, session branch or draft
fills. Everything the fill takes from the program comes from that one
revision: the cache's `fill.command`, `path` and `sizeMb`, the setup's network
and secrets, and its sandbox's admission (the Environment's image, its
Dockerfile, `containers` and network), never a newer `main` whose deploy is
pending or failed. The fill gets its own
Allocation on the machine, owned by the project and charged like any work:
a fresh sandbox of the Environment's image, holding the revision's checkout
alone, on the setup's network (the Environment's own when it has none), with
no grants and no secrets but the ones `setup.secrets` names, and the cache
mounted writable as a new empty generation. On exit 0 Work writes
`.work-cache.json` (cache, commit, fill, time) into the cache's root and
removes the sandbox, so nothing the command left running writes later. Then a
fresh helper sandbox of the machine's own image, which mounts the generation
read only and runs nothing of the fill's, checks its size against `sizeMb`.
Only then does Work publish the generation by marking the fill succeeded: one
row, so a sandbox sees the old generation or the new one, never a partial one. A failed, timed out or oversized fill leaves the old
generation in place, and what it wrote is removed before its sandbox goes.
Every step of a fill goes through its Allocation's guard and its claim, so a
released Allocation, a lost machine lease, or a claim another run took over
stops it before it publishes. The same helper searches the generation for
the values of the setup secrets the fill ran with (those of at least 8
characters, as written, JSON or URL escaped, base64 at every alignment, and
base64url), handed to it as files; one found refuses the fill, since every
sandbox of the Environment would read it (ADR 0257). This guards against a
trusted fill command's accidents, not a hostile one, which could encode a
value some other way.

**Requesting.** `host["catamorphic.environments"].fillCache({ environment,
cache, commit?, idempotencyKey })` needs the new permission `caches:write`.
The caller names neither the command nor a ref, so a workflow can trigger a
fill but cannot run a command of its own with the cache writable. A project
fills on a schedule. A deploy workflow (ADR 0331) runs before its own
revision goes live, so it cannot fill from it. A request fills every machine
holding a copy, or one placed machine when none does.

**Where caches live: on each machine.** A copy is a Docker volume per
generation on the machine (`cache-<name>-<digest>-g<generation>`). The
control plane hands each mount the cache's other generations on that machine
to retire: all but the published one and one being filled, so failed and
superseded generations go once no sandbox mounts them. A fill taken over after
its replica stopped keeps the generations its earlier attempts wrote in
`abandoned_generations`, so they are retired too, and the sandbox an earlier
attempt left is emptied before it is destroyed. On the machine, one lock per
cache spans finding a generation, creating the container that mounts it, and
retiring, pruning or removing every volume, so a generation is never removed between a
sandbox finding it and mounting it. A read-only generation the machine no
longer has (pruned, reset, re-enrolled) is never created empty: the sandbox
reports it skipped, Work forgets that copy and every older one, queues a fill,
and tells the agent the cache is missing. We considered one
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
is retried with a new generation, at most 3 times; the last one releases the
Allocation its attempt left, so the machine's cleanup frees its reservation. A
fill that finds no room on its machine backs off. One still queued an hour
after it last joined the queue fails, never counting time behind a running
fill of the same cache.

**Staleness and cleanup.** Each copy's commit and fill time are in its
`.work-cache.json` and in the turn's note on a new workspace. Copies no
sandbox mounted for `WORK_VOLUME_RETENTION_DAYS` (30) are evicted and never
mounted again. The machine prunes their volumes on its own schedule, and a
pooled machine's reset forgets them all. `GET /projects/:id/environment-caches`
shows operators each cache's copies, sizes, last use and the last fill's
error.

## Consequences

Review machines install from a cache filled at main. A setup that may mount
(the review sandbox, which runs its own Docker) lays a writable overlay over
the cache and fetches only what the pull request adds; the writes land in the
workspace, never in the cache; a real-container test under gVisor runs the
pack's own fill and setup with pnpm and proves it. A setup that cannot mount
installs offline from the cache, and a pull request that changes the lockfile then downloads
everything. A deploy workflow runs before its own revision goes live, so the
next scheduled fill takes a new revision. A cache is as fresh as its last fill, and a project
decides when that runs. Local-process, microsandbox and Cloudflare machines
do not offer caches. A fill uses one workspace's capacity on its machine
while it runs.
