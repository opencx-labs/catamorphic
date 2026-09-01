# 0080: Desktop updates and migration backups

- **Status:** Accepted
- **Date:** 2026-09-02

## Context

Manual replacement is a workable first-install path, but it leaves DMG users
without a clear way to discover and apply later alpha releases. Homebrew can
upgrade its own installs, but it does not cover direct installs. Desktop
versions also run forward-only PGlite migrations during startup, so an app
upgrade needs a recovery point before a newer binary opens the database.

Catamorphic's public tags use `desktop-v<version>`. The updater's GitHub
provider treats release tags as versions, so that product-specific prefix is
not compatible with its prerelease discovery. The release assets themselves
should still have one canonical home.

## Decision

GitHub Releases remains the canonical source for every signed and notarized
desktop artifact. Packaged macOS builds use `electron-updater` with a generic
channel feed at `opencx-labs/homebrew-tap/updates`. The feed contains only the
generated channel metadata rewritten to absolute GitHub Release asset URLs.
The tagged release workflow uploads the DMG, ZIP, blockmaps, metadata, and
checksums before it advances the Homebrew tap's channel pointer.

The app checks once shortly after launch, every six hours while running, and
after the Mac resumes from sleep. Background checks do not interrupt the user.
When an update exists, the app offers an explicit download, continues to work
while it downloads, and offers an explicit restart after verification. It
does not download automatically, install on ordinary quit, or restart while
an agent or terminal is active. A manual **Check for Updates** action remains
available in the Help menu. Prerelease builds stay on their prerelease channel.

Before a packaged app version first boots the embedded server, it copies the
closed PGlite directory into a versioned migration backup. Startup stops if
that copy cannot be made. The version is marked successful only after
migrations and server startup finish, and the app retains the two newest
pre-migration copies. Schema migrations remain forward-only; restoration is a
support and recovery operation, not automatic downgrade behavior.

The Homebrew cask declares `auto_updates true` because the same app can update
itself after installation. `brew upgrade --cask` remains a supported manual
path and the DMG remains a recovery install path.

## Consequences

DMG and Homebrew users share the same update behavior and signed artifacts.
Publishing is ordered so clients cannot see metadata before its referenced
assets exist. The tap now carries both the cask and the tiny update-channel
pointer, while no application binary is duplicated there.

An interrupted or incompatible migration has a recent local database copy,
but rolling back still requires an operator to restore the matching backup
and application version. The two-copy retention policy bounds disk use while
covering the current and immediately preceding upgrade boundaries.
