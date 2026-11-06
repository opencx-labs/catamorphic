# 0170: Attached repositories receive pull requests, never pushes

- **Status:** Accepted; refined by 0177 (`GithubService` is gone: publishing
  is `CodeHostsService.publishProject`, through the caller's or the
  organization's GitHub connection)
- **Date:** 2026-09-27
- **Refines:** 0044, 0104, 0159

## Context

A company that opens its main repository as a Work project must be able to
trust that Work never writes to the shared default branch behind anyone's
back. Three paths could: Work server provisioning committed role files and
pushed them to the default branch; `sync_project` pushed whatever branch was
checked out, including a person's own unpushed commits; and ADR 0044 sync
pushed `main` whenever it was ahead. The PR-first "review mode" deferred in
0044 was never built, and a per-project mode would leave the unsafe default
in place.

## Decision

**Work never updates a remote's default branch, or any branch it did not
create, in an attached repository. Everything Work originates reaches a
shared repository as a `work/*` branch plus a pull request.**

- Every linked network remote records who created it
  (`projects.remote_ownership`). `attached`: the repository existed before
  Work: an opened folder with an origin, a clone, a GitHub import, a Work
  server import. `owned`: Work created it (`GithubService.publishProject`).
  Unlinked projects record nothing, and anything unrecognised reads as
  attached.
- One guard in `@catamorphic/git`: `pushToRemote` requires the ownership and
  refuses, before contacting the remote, any attached push whose target is
  not a `work/` branch, any forced attached push, and any refspec in
  disguise. Every network push in core and every host goes through it; the
  unused `ProjectRepo.setRemote/fetch/push` bypass is removed.
- `syncWithNetworkRemote` on an attached remote fetches and fast-forwards a
  clean tree only. Local commits the remote lacks report `ahead`; conflicting
  histories report `diverged` with no merge and no rescue branch. Owned
  remotes keep 0044 behavior.
- `sync_project` tells the agent to share `ahead` or `diverged` work with
  `create_pull_request`. Proposals move under `work/proposals/`.
- Work server provisioning never commits to an imported repository. Roles on
  its default branch are used as they are; otherwise the supplied roles are
  proposed as a pull request. The admission policy may name proposed roles,
  but admission reads committed roles, so nobody joins with one until it
  merges; the server's published sync picks it up. Projects the server
  creates keep committing to their own origin. A server project attached to
  a code host refuses direct deploys; its changes go as pull requests or
  proposals. When its main still diverges from the code host's, the sync
  records since when (`remoteDivergedAt`) and the server says so, instead of
  silently no longer receiving updates.
- `pushProject` is replaced by `publishProject`, which creates a new
  repository and links it as owned; an already linked project is refused.

Rejected: a per-project review mode (unsafe by default); a pending-roles
overlay on the server (a second source of truth beside the default branch).

## Consequences

Opening, provisioning, or syncing an existing repository cannot move its
default branch, whatever the credential allows. Local commits in attached
projects wait for an explicit pull request. A server provisioned against an
attached repository admits nobody until its roles pull request merges. The
publishing skill's `gh repo create` path still leaves a project unlinked in
core; routing it through `publishProject` is follow-up work.
