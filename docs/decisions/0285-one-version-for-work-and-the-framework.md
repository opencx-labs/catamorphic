# 0285: One version for Work and the framework

- **Status:** Accepted (extends 0082, 0085 and 0159)
- **Date:** 2026-10-26

## Context

Work already releases the desktop and server image from one immutable tag.
Framework libraries remain unpublished workspace dependencies with unrelated
versions, preventing a new host from installing them from npm. User projects
also need the app, parser and workflow packages outside this repository.

## Decision

Every release uses one version for all workspace packages and applications.
The desktop manifest remains the version source. `release:version` updates all
workspace manifests and the lockfile together; the merge gate rejects drift.
Version constants used by seeded projects read package metadata.

The existing `desktop-v<version>` release publishes all importable libraries
under `@catamorphic/*` to the public npm registry. The deployed Cloudflare
Worker and the applications remain private, with synchronized versions.
Previews use `x.y.z-alpha.n` and npm's `alpha` tag; Stable uses `x.y.z` and
`latest`. Libraries do not advance independently.

The desktop workflow packs and tests every archive outside the monorepo before
building the desktop. It publishes those exact archives after the desktop
succeeds, using npm trusted publishing with GitHub OIDC. Manual dispatch only
builds and tests. Account/scope ownership, npm's staged package-name reservation
and trusted publisher registration are one-time setup; the first real release
already publishes through OIDC. Routine releases need no npm login, token
rotation or package approval.

Release runs are serialized. Registry preflight rejects an older version before
desktop publication and repeats before npm writes, preserving channel order.

## Consequences

Consumers can install a coherent framework release without a checkout or a
private registry. Archives include compiled code, supported Bun sources,
migrations and runner assets; declared host peers are exercised explicitly.
The release retains tarballs and their integrity inventory. Publication retries
skip byte-identical versions, reject conflicting immutable versions, and never
unpublish a partial release. npm and desktop distribution cannot be one atomic
transaction; a failed publication is unfinished release work to recover and
verify. Existing project lockfiles are not silently upgraded.
