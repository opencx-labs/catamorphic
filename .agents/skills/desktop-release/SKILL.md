---
name: desktop-release
description: Use when preparing, dry-running, publishing, repairing, or verifying a Catamorphic desktop prerelease through GitHub Releases and opencx-labs/homebrew-tap. Do not use for ordinary desktop development or framework package publishing.
---

# Desktop Release

Publish the macOS desktop app as a signed and notarized prerelease without
moving public tags, bypassing review, or leaving GitHub Releases and the
Homebrew update channel out of sync.

## Load the release contract

Before changing or publishing anything, read these current repository files
completely:

- `apps/desktop/RELEASING.md`
- `.github/workflows/desktop-prerelease.yml`
- `scripts/desktop-release.ts`
- `apps/desktop/package.json`

Read ADRs 0082 and 0083 when changing distribution or update behavior. If the
release includes database changes, also use the `database-conventions` skill
and read ADR 0084 plus the new migrations.

The current workflow supports Apple silicon macOS prereleases only. Do not
publish a stable version, Intel build, or another platform by weakening its
guards. Those require an explicit product decision and corresponding release
work first.

## Authority and hard stops

A direct request to "publish a release" authorizes the release-specific code
change, PR, dry run, annotated tag push, and monitoring and verification of
the resulting GitHub Release and tap update. It does not authorize bypassing
required reviewers, force-pushing or moving a public tag, weakening repository
or environment protections, installing the app on the user's Mac, or exposing
secret values.

If the user did not specify a version, inspect the current package version and
published releases, propose the next SemVer prerelease, and get confirmation
before changing the version or creating a tag. Never infer a stable release.

Stop before tagging when any of these is true:

- the release commit is not merged to `main`;
- CI for that exact commit is not successful;
- the dry-run workflow for that exact commit did not succeed;
- the `desktop-release` environment lacks its expected secret names or release
  protection;
- the tag or release already exists unexpectedly;
- the Homebrew tap or its release-writer path is not ready.

## Prepare the release

1. Work in a dedicated worktree and fetch `origin` and tags. Record the exact
   `origin/main` SHA, the latest `desktop-v*` release, and the intended version.
2. Inspect release-environment and ruleset metadata through `gh` without ever
   reading or printing secret values. Confirm the six secret names documented
   in `apps/desktop/RELEASING.md` exist.
3. If a version bump or release note change is needed, make it on a
   `codex/` branch. Keep `apps/desktop/package.json` and `bun.lock` in sync.
4. Validate the tag/version pair with `scripts/desktop-release.ts`, run its
   focused tests, then run the complete `bun run check` gate.
5. Commit and push the release preparation, open or update a PR, wait for its
   checks, and respect the required human review. Do not merge by bypass.
6. After merge, fetch again and verify the merged `main` SHA contains exactly
   the intended version and has successful CI. If `main` moved, repeat the
   exact-commit checks.

If `main` already contains the intended version and no release preparation is
needed, do not create an empty release PR.

## Dry run the exact commit

Dispatch `desktop-prerelease.yml` manually from `main`, capture its run id, and
verify the run's `headSha` equals the recorded release SHA. Monitor it to
completion. A manual dispatch signs, notarizes, verifies, and uploads workflow
artifacts, but must not create a GitHub Release or modify the tap.

Inspect the artifact inventory. For the first release, a signing-credential
change, or a material packaging change, pause for the clean-account installation
checks in `apps/desktop/RELEASING.md`. Do not claim Gatekeeper, URL-handler, or
real update UX validation that was not actually performed.

## Publish with an immutable tag

Immediately before tagging, recheck that `origin/main` is still the validated
SHA and that neither the remote tag nor a GitHub Release exists. Run the
release verifier once more.

Create an annotated `desktop-v<version>` tag at that exact SHA and push that
specific tag ref. Never reuse, move, delete, or force-push a published release
tag. The tag-triggered workflow is the only publisher: it creates the GitHub
prerelease first, then advances the cask and update metadata together in the
tap.

Monitor the tagged workflow to completion. Do not blindly retry failures. One
retry is reasonable only for a clearly transient external failure when the
same immutable tag and workflow are safe to rerun. If code at the tagged commit
is wrong, keep the tag as history, fix through a new PR, and publish a new
version. If publication partially succeeds, preserve the partial state and
report it precisely rather than deleting evidence.

## Verify the public release

Verify all of the following before reporting success:

- the GitHub release targets the intended tag and is marked as a prerelease;
- the DMG, ZIP, both blockmaps, channel metadata, and `SHA256SUMS.txt` exist;
- downloaded assets match the published checksums;
- `Casks/catamorphic.rb` contains the intended version and DMG checksum;
- the tap's channel metadata points only to assets from the intended GitHub
  release;
- the tap commit is newer than the release publication and both tap files
  advanced together;
- the release and tagged workflow URLs are recorded for the user.

Use a temporary directory for downloads and tap inspection. Do not run
`brew install`, replace `/Applications/Catamorphic.app`, or exercise an updater
against the user's installed copy without explicit permission.

Report any remaining manual checks separately. A first release cannot prove
the updater path by itself; verify direct DMG and Homebrew installation, then
use the next alpha to test in-app update and `brew upgrade` from the previous
public version.
