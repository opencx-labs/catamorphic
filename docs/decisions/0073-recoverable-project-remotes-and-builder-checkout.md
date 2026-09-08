# 0073: Recoverable project remotes and builder checkout

- **Status:** Accepted
- **Date:** 2026-08-26
- **Refines:** 0044, 0055, 0072

## Context

A project may run work in several Environments, but it has at most one
Catamorphic server remote. Keeping that remote only under an app-data project
id makes it disappear when profile data is lost and makes reconnect open an
empty form. A builder joining a code-host-backed remote also needs the actual
repository, while other members should receive only the documents their roles
grant.

Desktop users may already have an authenticated GitHub CLI. Requiring another
GitHub login is wasteful, but using `gh api` or `gh repo clone` would create a
second implementation of repository checks and checkout behavior.

## Decision

Every remote working copy stores a gitignored, non-secret
`.catamorphic/remote.json` locator. It contains a version, stable connection
id, server API URL, remote project id, and display name. OAuth access and
refresh credentials remain encrypted in profile storage and are keyed by the
stable connection id. App-data loss therefore preserves enough information to
show the remote and authorize again without leaking credentials into Git.

The server exposes builder status and project source metadata separately from
the Catamorphic remote locator. A builder joining a GitHub-backed project gets
a full repository clone. A non-builder gets the scoped document working copy.

The desktop checks its existing GitHub connection first. If it cannot read the
exact repository, it may invoke `gh auth token --hostname github.com` and pass
that token into `GithubService`. `GithubApi.getRepo` validates access before
the credential is stored. Repository listing, cloning, fetch, push, and pull
requests always use `GithubApi`, `GithubService`, `CodeHost`, and the shared git
engine. The desktop never invokes `gh api` or `gh repo clone`.

## Consequences

Reconnect is project-local and recoverable, and transient network failure does
not erase a remote binding. One project still has zero or one Catamorphic
remote; Environments remain execution choices beneath it, and a Git code-host
remote remains separate metadata.

Builders with working CLI credentials avoid a duplicate GitHub prompt. Missing
or insufficient repository access falls back to the same GitHub authorization
surface and resumes at the same exact-repository validation step.
