---
name: desktop-release
description: Use when preparing, dry-running, publishing, repairing, or verifying a Work desktop Stable or Preview release (macOS, GitHub Releases, and the opencx-labs/homebrew-tap casks and update feeds). Not for ordinary desktop development or for publishing framework npm packages.
---

# Desktop release

Publish the signed, notarized macOS app from one immutable tag, keeping GitHub
Releases and the Homebrew Stable and Preview channels in step.

## Read first

Read these completely before changing or publishing anything:

- [apps/desktop/RELEASING.md](../../../apps/desktop/RELEASING.md): setup, secrets,
  dry run, publication steps, channels, and clean-account checks.
- [.github/workflows/desktop-prerelease.yml](../../../.github/workflows/desktop-prerelease.yml)
  (workflow name "Desktop release"): tag pushes publish, manual dispatch only
  builds and verifies.
- [scripts/desktop-release.ts](../../../scripts/desktop-release.ts): tag, version,
  cask and feed rules.
- `apps/desktop/package.json`: the version being released.

When changing distribution, updates or harness packaging, also read ADRs
[0082](../../../docs/decisions/0082-desktop-prerelease-distribution.md),
[0083](../../../docs/decisions/0083-desktop-updates-and-migration-backups.md),
[0085](../../../docs/decisions/0085-desktop-stable-and-preview-channels.md),
[0091](../../../docs/decisions/0091-on-demand-desktop-harness-components.md) and
[0146](../../../docs/decisions/0146-work-application-identity.md). When the release
carries new migrations, use the `database-conventions` skill and read them; packaged
apps back up the database before migrating (ADR 0083).

Supported today: Apple silicon macOS only. Stable is `x.y.z`, Preview is
`x.y.z-alpha.n`. Another prerelease name, a nightly, Intel or another platform
needs a product decision and release work first; never weaken the guards to get one.

## Authority

A direct request to publish a release authorizes the release preparation change
and PR, the dry run, pushing the annotated tag, and monitoring and verifying the
result. It does not authorize bypassing required reviewers, moving or force-pushing
a public tag, weakening repository or environment protections, installing the app
on the user's Mac, or reading secret values.

If the user did not name a version and channel, look at the package version and
published `desktop-v*` releases, propose the next version, and wait for
confirmation. "Release" alone does not mean Stable.

## Stop before tagging if

- the release commit is not on `main`, or CI for that exact commit did not pass;
- the dry run for that exact commit did not succeed;
- the `desktop-release` environment lacks one of the six secret names in
  RELEASING.md or its reviewer and branch/tag protection;
- the tag or a GitHub release for it already exists;
- the tap or its token is not ready (the dry run checks tap write access).

## 1. Prepare

1. Work in a dedicated worktree. Fetch `origin` with tags. Record the `origin/main`
   SHA, the latest `desktop-v*` release, and the intended version.
2. Check environment and ruleset metadata with `gh` (for example
   `gh secret list --env desktop-release` lists names only). Never print values.
3. If the version needs a bump, change `apps/desktop/package.json` on a branch and
   keep `bun.lock` consistent. Check the pair:
   `bun scripts/desktop-release.ts verify --tag desktop-v<version> --package-version <version>`
   and `bun run test:file scripts/desktop-release.test.ts`.
4. If Claude Code or Codex dependencies changed, update
   `apps/desktop/src/main/harness-components.ts` together: platform package
   version, tarball URL and SHA-512 integrity for every supported platform. Run
   its tests. Never ship a floating version or a missing integrity pin.
5. Run `bun run check`, push, open the PR, wait for checks and the required human
   review. Never merge by bypass.
6. After merge, fetch again and confirm `main` has the intended version and green
   CI. If `main` moved since, repeat the exact-commit checks on the new SHA.

If `main` already carries the intended version, skip the PR.

## 2. Dry run the exact commit

```sh
gh workflow run desktop-prerelease.yml --ref main
gh run list --workflow desktop-prerelease.yml --limit 1 --json databaseId,headSha,status
```

Confirm the run's `headSha` is the recorded SHA and watch it to completion
(`gh run watch <id>`). The environment requires reviewer approval, so the run
waits for a person. A dispatch signs, notarizes, verifies and uploads the DMG,
ZIP, blockmaps, feed and `SHA256SUMS.txt` as workflow artifacts. It never creates
a release or touches the tap.

For a signing-credential change or a material packaging change, pause for the
clean-account install checks in RELEASING.md. Never claim Gatekeeper, URL-handler,
harness first-use or update checks you did not perform.

## 3. Publish with an immutable tag

Right before tagging, recheck that `origin/main` is still the validated SHA, that
the tag and release do not exist, and rerun the verifier. Then:

```sh
git tag -a desktop-v<version> <sha> -m "Work <version>"
git push origin refs/tags/desktop-v<version>
```

The tag workflow is the only publisher. Preview creates a GitHub prerelease and
advances `Casks/work@alpha.rb` and `updates/alpha-mac.yml`. Stable creates the
latest release and advances both casks and both feeds (`latest-mac.yml`,
`alpha-mac.yml`) so Preview users converge on it.

Watch the tag run to completion. Diagnose a failure before rerunning. The
publication steps are idempotent (assets are replaced, unchanged tap files make no
commit), so rerunning the same tag's workflow is safe once the cause was transient
or external. If the tagged code is wrong, keep the tag as history, fix it in a new
PR, and release a new version. Never move, delete or reuse a published tag. If
publication partly succeeded, leave the partial state and report it exactly.

## 4. Verify the public release

Use a temporary directory for downloads and a tap clone. Confirm:

- the release targets the tag, with the right prerelease or latest state;
- the DMG, ZIP, both blockmaps, the channel feed and `SHA256SUMS.txt` exist, and
  downloaded assets match the checksums;
- the tap files for the channel (above) all advanced in one commit made after the
  release was published, each cask names the version and DMG checksum, and each
  feed points only at this release's assets;
- the release and workflow run URLs are recorded for the user.

Do not run `brew install`, replace `/Applications/Work.app`, or run an updater
against the user's copy without explicit permission. List the manual checks that
remain: clean-account install, harness first-use download and offline restart, and
on the next release of each channel, in-app update and `brew upgrade` from the
previous public version.
