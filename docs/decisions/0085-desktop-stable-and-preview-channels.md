# 0085: Desktop Stable and Preview release channels

- **Status:** Accepted
- **Date:** 2026-09-02

## Context

Catamorphic needs frequent macOS releases while the desktop is young, but many
users value a predictable update line more than immediate access to changes.
Putting every build on one channel would either expose all users to alpha risk
or slow down the feedback loop. Calling intentional prereleases "Nightly"
would also promise an unattended build from the latest main commit, which the
release process does not provide.

## Decision

The desktop has two supported release channels: **Stable** and **Preview**.
Stable releases use versions such as `0.1.0`, are normal GitHub Releases marked
latest, publish `latest-mac.yml`, and update the `catamorphic` Homebrew cask.
Preview releases use versions such as `0.2.0-alpha.1`, are GitHub prereleases,
publish `alpha-mac.yml`, and update the `catamorphic@alpha` cask. Both channels
use the same signed and notarized asset pipeline and immutable
`desktop-v<version>` tags.

Publishing a Stable release advances both feeds and both casks to that Stable
version. Preview users therefore converge onto a newer Stable build instead of
remaining on an older alpha line. Publishing a Preview release changes only
the Preview feed and cask, so Stable users never receive it.

The installed app exposes a machine-wide radio choice at **Help > Update
Channel** and persists it in the desktop user-data directory. A Stable build
defaults to Stable and an alpha build defaults to Preview. Selecting another
channel checks for a newer matching release immediately. Channel changes never
permit a downgrade, so moving from Preview to Stable can require waiting for a
Stable version newer than the installed alpha.

The name Nightly is reserved for a possible future channel built
automatically from main on a schedule. Adding it requires its own publishing,
retention, and support policy rather than treating manually published alpha
releases as nightlies.

## Consequences

Users can choose speed or predictability without separate application builds.
The GitHub release, in-app updater, and Homebrew casks share one version policy,
and a Stable publication becomes the common convergence point.

Release automation and verification must distinguish Stable from Preview and
keep the appropriate feeds and casks atomic. Maintainers must choose the
channel through SemVer when preparing a release. Switching away from Preview
may not have an immediate update path because automatic downgrades remain
forbidden.
