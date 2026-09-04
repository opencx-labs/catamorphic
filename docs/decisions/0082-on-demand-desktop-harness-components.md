# 0082 — Desktop coding harnesses use verified on-demand components

- **Status:** Accepted
- **Date:** 2026-09-04

## Context

The desktop packages the Claude Code and Codex TypeScript SDKs so either
harness works without a separate installation. Their platform executables are
about 258 MB and 297 MB on macOS arm64, dominating the installed application
even for people who never use those harnesses. Loading the modules lazily saves
memory but cannot reduce the distribution size.

Downloading arbitrary npm JavaScript into Electron's privileged main process
would turn package resolution into a remote-code update channel outside the
signed application. The SDK adapters are small, while their native optional
dependencies contain almost all of the bytes. Both SDKs accept an explicit CLI
path.

## Decision

The desktop ships its Catamorphic adapters and the JavaScript SDKs, but excludes
the Claude Code and Codex platform packages from the application artifact. On
first use of a harness, the desktop downloads only that platform's exact npm
tarball into its app-owned data directory.

The app release pins the SDK version, tarball URL, and SHA-512 integrity for
every supported platform. Installation uses HTTPS, rejects redirects and
unlisted origins, verifies the complete archive before extraction, extracts
through a temporary directory, and atomically publishes the verified payload.
The cached component is reused offline. Harness processes always receive its
explicit executable path; downloaded JavaScript is never imported into the
Electron process.

We rejected fetching floating npm versions, evaluating remotely downloaded
modules, relying on a system package manager, and silently downloading every
harness after app launch. Those alternatives respectively weaken release
reproducibility, expand the privileged-code supply chain, assume host tooling,
or restore the disk and network cost for non-users.

## Consequences

The base installer and installed app become substantially smaller. The first
use of Claude Code or Codex requires network access and may pause while its
component downloads; later use is offline. Updating either SDK requires an
intentional dependency and integrity-manifest update in the same release.
Download failures remain retryable and never leave a partially installed
component. A future settings surface may expose component status, progress,
removal, and preinstallation without changing this storage contract.
