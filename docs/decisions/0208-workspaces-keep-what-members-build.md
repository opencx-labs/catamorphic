# 0208 — Workspaces keep what members build: setup and volumes

- **Status:** Accepted
- **Date:** 2026-10-06
- **Refines:** 0173, 0176, 0184

## Context

Each chat gets its own sandbox, released after it idles (ADR 0173). An image
holds a team's toolchain (ADR 0176), but every new workspace still installed
the project's dependencies from nothing, re-pulled its Docker images, and lost
a member's own tools. A persistent machine bought nothing beyond its image
cache.

## Decision

**Setup.** An Environment's `setup` is a shell command run in the project
folder of every new workspace, and again when the command changes, after
secrets and personal files are in place and before the turn
(`setupTimeoutMinutes`, default 30). A member may add their own `setup` in
`.work/personal/environment.json`; it runs after the Environment's, only in
their own chats where personal credentials are allowed. Output goes to
`.work-session/setup.log`, the chat shows that the workspace is being set
up, and a failure is told to the agent with the end of the log; the turn
goes on.

**Volumes.** An Environment's `volumes` name directories that persist on the
machine for each owner (a member, or the project for its own chats) and
project: `{ "pnpm": "~/.local/share/pnpm/store", "docker": { "path":
"/var/lib/docker", "exclusive": true, "sizeMb": 20480 } }`. `~` is the
sandbox user's home. A volume is mounted into every sandbox of its owner on
that machine. An `exclusive` volume, such as a Docker data root or a
database, is mounted into one sandbox at a time: placement records which, and
a sandbox that starts while it is held gets an empty temporary one and is
told. Machines advertise `volumes`; local-process supports only paths under
`~`. A machine forgets volumes nobody used for 30 days
(`WORK_VOLUME_RETENTION_DAYS`) and a member's volumes when a pooled machine
is reset (ADR 0205).

Considered: a Dockerfile build context with the lockfile, so images hold
dependencies (every lockfile change rebuilds every machine's image), and one
persistent home per member (concurrent chats would share and break it).

## Consequences

The second workspace on a machine installs from warm caches and reuses its
Docker images. Volumes hold whatever the owner's code writes there,
credentials included, and stay on that machine only. Moving to another
machine starts cold.
