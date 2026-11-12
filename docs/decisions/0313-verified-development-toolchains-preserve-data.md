# 0313 — Verified development toolchains preserve data

- **Status:** Accepted
- **Date:** 2026-11-11

## Context

The repository's Node platform packages and official Docker tags can lag a
security release. Waiting for those wrappers leaves development and test
commands on vulnerable bytes. Container image upgrades also cross storage
contracts: PostgreSQL 18 uses a versioned data directory, while existing
development volumes hold PostgreSQL 17 data at their root.

## Decision

`scripts/tool-runtime.ts` remains the single repository Node acquisition and
resolution primitive. Root `bun install` runs its explicit installer, which
downloads the official Node archive for the supported macOS or Linux architecture,
checks a reviewed SHA256 pin, validates its version, and atomically publishes
the binary in an ignored checkout-local cache. Test, build and development
launches resolve that installed binary offline and reject missing or mismatched
versions. Remove npm platform wrappers rather than retain a second acquisition
path. Docker may use the latest published Node image only to bootstrap installation;
repository commands use the verified security release.

Pin third-party CI actions by release commit and container fixtures by image
digest. Upgrade generated app manifests and registry dependency metadata with
the workspace packages so new projects receive the supported toolchain.

The Compose development database retains its existing `pgdata` volume. Mount
it at PostgreSQL 18's parent data directory and retain the official entrypoint's
old-cluster detection. Existing PostgreSQL 17 data must cause an explicit upgrade
error, never an empty replacement database. Database migration remains a separate
operator action with verified backup and rollback data; dependency installation
does not migrate or reset development databases or profiles.

## Consequences

Fresh installation needs Node's official release host and an archive extractor;
subsequent tool launches work offline. Reviewers maintain checksums with runtime
versions. Development databases can require an explicit major-version migration,
with the old data preserved. Embedders continue to choose their own runtime,
database, container images and deployment procedure.

Official contracts: [Node release checksums](https://nodejs.org/dist/v26.13.1/SHASUMS256.txt),
[PostgreSQL image data layout](https://github.com/docker-library/docs/blob/master/postgres/README.md).
