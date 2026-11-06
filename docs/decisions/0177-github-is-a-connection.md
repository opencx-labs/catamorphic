# 0177 — GitHub is a connection

- **Status:** Accepted
- **Date:** 2026-09-27
- **Supersedes in part:** 0044 (the GitHub `CodeHost` and its token store), 0073 (`GithubService` as the CLI credential's destination), 0074 (the GitHub monitor and `github.*` kinds)
- **Refines:** 0113, 0117, 0162, 0170, 0171, 0172

## Context

GitHub was special everywhere: core had a `GithubService` with its own token
store, `/github/*` routes, a scoped `github` resource, a GitHub event poller,
`create_github_watcher`, and framework `github.*` trigger kinds; the Work
server ran on a static `WORK_GITHUB_TOKEN`; agents could reach GitHub only
through a hand-written gateway entry. Meanwhile ADRs 0162, 0171 and 0172
made connections, project trigger kinds and named service connections the
general way to reach any system, and the `github` connection provider
(App installation tokens, user OAuth, Git credentials) now exists.

## Decision

**Code hosts over connections.** `createCatamorphic({ codeHosts })` replaces
`github`. A `CodeHost` names a connection provider and adds pull requests
(create, list, read, discussion, comment, files, review, merge) and
repositories (list, read, create); Git credentials come from the provider's
`git` capability, so a remote is served by whichever provider's remote base
covers it. `CodeHostsService` opens one connection per call on the control
plane: the caller's own (one they authorized in the project, else their
**personal connection**, a member connection bound to no project), else the
service connection named like the provider, the project's before the
organization's (ADR 0172). Remote sync, pull requests, repository import and
publishing use it; proposals use only the service connection, so members act
through the organization (the old `proposalBot` is gone). Push safety stays
in `packages/git` (ADR 0170). `githubCodeHost(provider)` in the server SDK is
the GitHub implementation; tokens are minted per call, narrowed to the
repository and permissions it needs. The provider's own actions (REST and
typed) keep to the binding's Git policy: the broker passes the repositories
the binding reaches (`git.repositories`, else the project's linked remote,
the set the Git gateway enforces), paths outside one repository are refused
unless the host names them, a `get` mints read-only permissions, and no
write targets the default branch.

**Providers know whose authority they authorize.** `begin/completeAuthorization`
receive `principal`. GitHub signs a person in (device or web flow) and asks
an administrator for an App (ID, private key, installation) through a form,
so the ordinary service-connection operations connect an App.

**One primitive for events.** The GitHub monitor, `create_github_watcher`,
`WatchersService.createGithub` and the `github.*` host kinds are deleted.
`create_watcher` takes an `eventSource`, a host-registered polled source. The
desktop, which has no public URL, registers one named `github` that records
repository activity as deliveries to the project's `github` webhook:
`x-github-event` and `x-github-delivery` headers, webhook-shaped bodies
(Events API payloads as sent; pull request, check and workflow run
snapshots with the action their state implies), and `hostVerified: true` in
place of a signature. The same `.work/triggers/github.ts` library and `where`
filters therefore match on the desktop (polled) and on a server (pushed and
signed). Skill examples name the kinds `github.*` again.

**Work server.** The `github` provider and code host are built in. An
administrator connects the App installation as the `github` service
connection, or the operator registers a new App from a manifest
(`POST /_work/operator/github/app`, then a one-time browser link): GitHub
converts the code, the operator installs the App, and the installation
becomes the connection; with a project, the App's webhook points at that
project's `github` URL and its secret is stored as `GITHUB_WEBHOOK_SECRET`
when the project declares it. The registration in progress lives in
`work_github_app_registrations` (migration 036: the state's hash, each step
claimed once, the App's credentials sealed in the vault until connected), so
any replica continues it; the App's OAuth client is shown once at the end
for members' own accounts. Provisioning attaches repositories through the
service connection; the published-sync loop covers every linked project.

**Desktop.** GitHub sign-in authorizes the personal `github` connection
through core; the file token store is gone. The optional `gh` CLI (ADR 0117)
remains host code: its token becomes that connection only after it reads the
exact repository, and local pull request reads fall back to it. Local pull
request reads, reviews, merges and comments use the code host first.
`WORK_GITHUB_CLIENT_ID` / `WORK_GITHUB_APP_SLUG` override the App.

**Two kinds of App.** The public **Work Desktop** App (`work-desktop`, owned
by `opencx-labs`) only
signs people in to their own GitHub accounts from the desktop: it needs just
its client ID, and no key leaves its owners. Each Work server connects its
own **private** App, owned by the organization it serves and registered from
the server's manifest, as the `github` service connection. A shared public
App would put a key that mints tokens for every installing organization on
each server, and could deliver webhooks to only one server.

Considered: keeping a GitHub service beside connections (two credential
paths), per-integration host kinds for polling (a second event model), and a
separate GitHub-shaped polled payload (the trigger library would need two
variants).

## Consequences

GitHub reaches agents, workflows, sync and proposals through one connection
with audited, narrowed tokens; other code hosts are a provider plus a code
host. Polled events arrive at most one poll interval late and approximate
webhook actions for snapshots; pushes are delivered without per-commit
detail when GitHub's Events API omits it. SSH origins still fall back to the
CLI for pull request reads. Creating a server's private App and installing
it needs an organization owner in a browser.
