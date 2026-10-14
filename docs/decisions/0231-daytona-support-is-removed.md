# 0231 — Daytona support is removed

- **Status:** Accepted (amends [0004](0004-cloudflare-first-infrastructure.md), [0008](0008-vendor-plugin-packages.md) and [0174](0174-background-processes-as-a-sandbox-capability.md))
- **Date:** 2026-10-14

## Context

`@catamorphic/daytona` held a `DaytonaSandboxProvider`, an experimental
`DaytonaBackend` storage backend and a `DaytonaProjectRepo`. No host in the
repository constructs any of them: the desktop runs microsandbox, the Work
server chooses microsandbox, gVisor containers or local processes, and the
documented cloud path is Cloudflare. Its only tests were credentialed integrations that
`bun run test:external` ran on request, and the provider offers none of the
sandbox capabilities added since: background processes and the terminals and
previews built on them, images and egress policy, resource limits, volumes.

Its SDK, `@daytonaio/sdk`, was also the heaviest vendor tree in the
lockfile: 97 entries no other workspace reaches, among them a second
OpenTelemetry SDK, an AWS S3 upload client and a Socket.IO client, and the
only paths to a critical `shell-quote` advisory and twelve `axios`
advisories.

## Decision

Daytona is no longer supported. The package, its environment variable
(`DAYTONA_API_KEY`), its external test filter and every reference in the
guides and skills are removed. Cloudflare is the cloud sandbox provider;
microsandbox, `@catamorphic/container` and `@catamorphic/local-process` are
the local ones. Background processes on Cloudflare remain follow-up work
(ADR 0174); the Daytona half of that follow-up is dropped.

Kept as it was: the provider contract. A host that needs Daytona can still
implement `SandboxProvider` (and `StorageBackend`) in its own package, as
ADR 0008 intended for every vendor.

Considered: keeping the package unmaintained. It would keep shipping a
provider that silently lacks the capabilities the server now relies on, and
keep its advisories in every audit.

## Consequences

- Every install and audit is smaller; the axios and shell-quote advisories
  are gone with it.
- ADRs 0004 and 0008 describe Daytona as an alternate provider, and ADR 0174
  lists Daytona support as follow-up work; this record amends all three. Dated plans and specs under `docs/superpowers/`
  are left as the history they are.
- The `DAYTONA_API_KEY` repository secret is no longer read by CI and can be
  deleted.
