# 0004 — Cloudflare-first infrastructure (Sandbox now, Artifacts next)

- **Status:** Accepted (updated by [0008](0008-vendor-plugin-packages.md): implementations moved to `@catamorphic/cloudflare`; `createSandboxProviderFromEnv()` removed; `ArtifactsRemoteBackend` implemented)
- **Date:** 2026-07-02

## Context

Workflow execution needs isolated sandboxes; project code needs durable git storage. We had two sandbox providers (Daytona, Cloudflare Sandbox via the Bridge Worker) with Daytona as the default, and filesystem-based bare git remotes. Cloudflare's agent-infrastructure stack — Sandbox for execution, [Artifacts](https://www.cloudflare.com/products/artifacts/) for Git-compatible storage at repo-per-user scale — aligns with catamorphic's model: one repo per project, one sandbox per deployment, agents interacting through plain git.

## Decision

**Cloudflare is the priority stack** for sandboxing and code storage:

- **Execution (now):** `CloudflareSandboxProvider` (via the Bridge Worker, `packages/cloudflare-sandbox-bridge`) is the default. `createSandboxProviderFromEnv()` selects Cloudflare whenever `CLOUDFLARE_SANDBOX_API_URL` is set and falls back to Daytona otherwise. Daytona remains a maintained alternate behind the same `SandboxProvider` contract — providers stay pluggable so hosts can bring their own.
- **Code storage (next):** implement `ArtifactsBackend` in `packages/git` — Artifacts REST for repo creation and short-lived token minting, `isomorphic-git` over HTTPS for sync. Run materialization then changes from "upload working tree into the sandbox" to "`git clone` the Artifacts remote inside the sandbox", which is cheaper, cacheable, and gives agents a real remote. `FsBackend` remains for local dev/CI and simple hosts.

Operational detail lives in `CLOUDFLARE.md`.

## Consequences

- This reverses the previous "Daytona is the default until further notice" rule; docs and env selection helpers reflect Cloudflare-first.
- Artifacts is in beta; `ArtifactsBackend` is roadmap work gated on account access (tracked in `CLOUDFLARE.md` → TODO).
- The Bridge Worker becomes a deployment prerequisite for the default execution path; hosts without Cloudflare accounts use Daytona or a custom provider.
