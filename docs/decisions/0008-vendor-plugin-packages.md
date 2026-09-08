# 0008 — Vendor backends live in plugin packages

- **Status**: accepted
- **Date**: 2026-07-02

## Context

`@catamorphic/sandbox` originally contained both the provider contract and the
concrete Cloudflare + Daytona implementations, and `@catamorphic/git` bundled
the Daytona storage backend. Every embedder therefore pulled in every vendor
SDK (`@daytonaio/sdk`, Cloudflare-specific HTTP clients) regardless of which
backend they actually used, and adding a new backend meant touching the core
packages.

## Decision

Backends are **vendor plugin packages** that the host chooses to install:

- `@catamorphic/sandbox` keeps only vendor-neutral code: the
  `SandboxProvider` / `SandboxManager` / `RunExecutor` contracts and
  implementations, coding-agent contracts, OpenTelemetry instrumentation
  (`instrumentSandboxProvider`), and agent file-staging helpers. Concrete
  coding agents live in their own packages per later ADRs.
- `@catamorphic/git` keeps only vendor-neutral storage: `StorageBackend` /
  `RemoteBackend` / `OriginRepo` contracts, `ProjectManager`, git-sync, and
  the filesystem backends.
- `@catamorphic/cloudflare` — `CloudflareSandboxProvider` (Bridge Worker
  client) + `ArtifactsClient` / `ArtifactsRemoteBackend` (Cloudflare Artifacts
  code storage). The default, recommended stack (ADR 0004).
- `@catamorphic/daytona` — `DaytonaSandboxProvider` + the experimental
  Daytona git storage backend.
- Later packages follow the same seam: `@catamorphic/microsandbox` for local
  sandbox execution, `@catamorphic/local-process` for trusted single-tenant
  subprocess execution, and `@catamorphic/s3` for S3-compatible git origins.

`createSandboxProviderFromEnv()` was removed: an env-sniffing helper would
force the core package (or the server-sdk) to depend on every vendor plugin,
defeating the split. Hosts construct their chosen provider explicitly, expose
it through the required `environmentProvider`, and pass `sandboxProvider` when
execution or controller agents need the default provider directly.
Environment-based selection is host boot code; see
`apps/desktop/src/main/server/boot.ts` and `apps/server/src/server.ts` for the
current reference patterns.

## Consequences

- Embedders install exactly the vendor SDKs they use; new backends are new
  packages, not core changes.
- `RemoteBackend` gained an optional `getCloneSource()` capability so
  network-remote backends (Artifacts) can hand sandboxes a URL + short-lived
  token to `git clone` directly, instead of the host uploading files. FS
  backends simply don't implement it and the upload path is used.
- Docs/examples must show explicit provider construction rather than a magic
  env helper.
