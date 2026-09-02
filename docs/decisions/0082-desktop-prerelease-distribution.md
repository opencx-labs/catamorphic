# 0082: Desktop prerelease distribution

- **Status:** Accepted; update policy superseded by [0083](0083-desktop-updates-and-migration-backups.md)
- **Date:** 2026-08-29

## Context

The desktop app has a development packaging configuration, but Catamorphic has
not published an installable desktop release. The first public build fixes
identities and distribution contracts that become costly to change after
installation: the bundle id, connect-link scheme, version tags, supported
architecture, canonical artifact names, and update source.

The app includes architecture-specific native sandbox and coding-agent
binaries. A universal build would require validating every native dependency
on both architectures before the first release. Automatic updates introduce a
second release protocol that is not needed to validate installation and the
public alpha feedback loop.

## Decision

The first desktop release line supports Apple silicon on macOS 12 or newer.
`apps/desktop/package.json` is the desktop version source, and prerelease tags
use `desktop-v<version>`, beginning with `desktop-v0.1.0-alpha.1`. GitHub
Releases is the canonical binary source. Every release contains a Developer
ID-signed and Apple-notarized DMG, a ZIP of the same app, and SHA-256 checksums.
GitHub marks these releases as prereleases.

The direct-install experience is the DMG's normal drag-to-Applications flow.
Homebrew installs that same DMG from the `opencx-labs/homebrew-tap` cask. The
release workflow renders the cask from the released version and checksum after
the GitHub release is available. It never builds a second Homebrew-specific
application artifact.

The packaged identity is `dev.catamorphic.desktop`, and the application owns
the `catamorphic` URL scheme used by credential-free remote project and
invitation locators. Release builds use hardened runtime and fail unless code
signing, notarization, signature verification, Gatekeeper assessment, and
ticket validation all succeed.

The first alpha has no in-app updater. Homebrew users update with Homebrew and
DMG users install a newer release over the existing application. The ZIP keeps
the release shape compatible with a later electron-updater channel without
committing to that channel now.

The bundled Claude Code, Codex, and local sandbox binaries remain in the first
alpha so the installed app preserves its local-first and multi-harness
behavior. Reducing download size through on-demand harness installation is a
separate product and licensing decision.

## Consequences

The first release reaches the current majority Mac architecture with one
native dependency matrix and one Gatekeeper path. Intel macOS, Windows, Linux,
and automatic updates require later explicit support work.

The release workflow needs a Developer ID Application certificate, App Store
Connect notarization credentials, and scoped write access to the Homebrew tap.
Unsigned local packaging remains available for development, but only the
tagged workflow may create public release artifacts.

The bundle id and URL scheme are now stable public contracts. Changing either
requires a migration plan for installed application data, operating-system
registration, and remote connect links.
