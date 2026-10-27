# Releasing the desktop app

The desktop release contract is recorded in
[ADR 0082](../../docs/decisions/0082-desktop-prerelease-distribution.md) and
[ADR 0083](../../docs/decisions/0083-desktop-updates-and-migration-backups.md),
with Stable and Preview channels defined by
[ADR 0085](../../docs/decisions/0085-desktop-stable-and-preview-channels.md)
and integrity-pinned, on-demand harness components defined by
[ADR 0091](../../docs/decisions/0091-on-demand-desktop-harness-components.md).
GitHub Releases is the canonical binary source. The Homebrew casks install the
same notarized DMG, and the tap carries the small metadata files packaged apps
use to discover updates.

The npm libraries use this same release and version
([ADR 0285](../../docs/decisions/0285-one-version-for-work-and-the-framework.md)).
There is no separate library release or package version bump.

## One-time setup

1. Join the Apple Developer Program and create a Developer ID Application
   certificate. Export the certificate and private key from Keychain Access as
   a password-protected P12 file.
2. Create an App Store Connect API key with access to notarization. Download
   the P8 private key and record its key id and issuer id.
3. Create the public `opencx-labs/homebrew-tap` repository with `main` as its
   default branch. The workflow maintains its `Casks` and `updates`
   directories.
4. Create a `desktop-release` GitHub environment in this repository. Require a
   reviewer and restrict deployments to the `main` branch and `desktop-v*`
   tags.
5. Configure these environment secrets:

| Secret | Value |
| --- | --- |
| `MACOS_CERTIFICATE_P12_BASE64` | Base64-encoded Developer ID Application P12 |
| `MACOS_CERTIFICATE_PASSWORD` | Password used when exporting the P12 |
| `APPLE_API_KEY_P8_BASE64` | Base64-encoded App Store Connect P8 private key |
| `APPLE_API_KEY_ID` | App Store Connect API key id |
| `APPLE_API_ISSUER` | App Store Connect API issuer id |
| `HOMEBREW_TAP_TOKEN` | Fine-grained token with Contents write access to `opencx-labs/homebrew-tap` |

On macOS, encode a credential without line wrapping like this:

```bash
base64 -i AuthKey_EXAMPLE.p8 | tr -d '\n'
```

Never commit certificates, keys, passwords, or encoded credentials.

## Dry run

Run the `Desktop release` workflow manually from the intended commit on `main`. A
manual dispatch verifies Homebrew tap write access, builds, signs, notarizes,
and verifies the app, then retains the DMG, ZIP, blockmaps, update metadata,
and checksum file as workflow artifacts. It does not create a GitHub release
or change the Homebrew tap.

A manual dispatch from a feature branch verifies only npm packages. Signing
remains restricted to `main` and release tags by the desktop environment.

Install the DMG from the workflow artifact on a clean Apple silicon Mac user
account. Verify:

- Gatekeeper opens Work without an override.
- Applications shows the Work icon and bundle identity: the Dock and
  Finder draw the flat orange W, on macOS 26 and on an earlier macOS.
- A `work://connect` invitation opens the installed app.
- A local project can be created, reopened, and edited.
- Claude Code and Codex each perform their one-time verified component
  download, start successfully, and start again from the cached component
  while offline. The built-in API harness, terminal, and local sandbox paths
  intended for the release also start successfully.
- A remote project can sign in, sync, mirror a conversation, and continue in
  the hosted PWA.
- `LICENSE.txt`, `NOTICE.txt`, and the bundled PWA are present in the app
  resources.
- Help > Update Channel selects Stable or Preview, and Check for Updates
  reports the expected result for each published feed.

## Publish a release

1. Run `bun run release:version --version <version>`: `x.y.z` for Stable
   or `x.y.z-alpha.n` for Preview. This updates every workspace manifest and
   `bun.lock`; `apps/desktop/package.json` remains the version source. Do not
   edit just the desktop version. `bun run release:verify` and the merge gate
   reject drift.
2. Merge the release change to `main` and wait for CI to pass.
3. Create and push an annotated `desktop-v<version>` tag at that exact commit.

The tag workflow rejects unsupported prerelease names and any tag that does
not match the desktop package version. It then:

1. Builds and packs every public library on Linux, checks the actual archives,
   installs them into an independent consumer with their declared host peers,
   imports their JavaScript entries with Node and Bun, checks their declarations,
   and boots a new Work server from the installed packages. The exact archives
   and SHA-512 inventory are retained as `npm-packages-<version>`.
2. Builds the repository on an Apple silicon GitHub runner, with the
   runner's newest Xcode 26 selected: only its `actool` compiles the Icon
   Composer app icon (`build/icon.icon`), so packaging elsewhere needs Xcode
   26 too.
3. Signs the app with Developer ID and submits it to Apple's notary service.
4. Verifies the signature, Gatekeeper assessment, stapled ticket, bundle id,
   URL scheme, the icon's asset catalog, DMG, and ZIP.
5. Rewrites generated update metadata to the tagged GitHub asset URLs.
6. Creates or updates the GitHub release and uploads the DMG, ZIP, blockmaps,
   update metadata, and SHA-256 checksums. Preview builds are prereleases;
   Stable builds are the latest full release.
7. Generates the applicable Homebrew casks from the released DMG checksum,
   validates their Ruby syntax and style, then advances the casks and channel
   feeds together in the Homebrew tap. Stable releases advance both channels
   so Preview users converge on the vetted build.
8. Publishes those verified library tarballs to the public npm registry, in
   dependency order, using GitHub OIDC. Preview versions use `alpha`; Stable
   versions use `latest`. This adds no package approval or token prompt to a
   release. The existing desktop environment review remains unchanged.

The publication steps are rerunnable. Existing release assets are replaced,
and an unchanged cask and feed produce no tap commit. GitHub assets are always
published before the feed points clients to them.

Release workflow runs are serialized across tags and dry runs. A tag run checks
existing npm channels before desktop publication and again before npm writes;
an older release cannot move either managed channel backward.

For npm, every archive is checked against the source version and full package
inventory before publication. A rerun skips versions with the same SHA-512
integrity and rejects conflicting immutable versions before writing any package.
After publication, it checks every version, integrity and channel tag. If npm
publication partly succeeds, retain the published packages and recover the
workflow; never unpublish or move the release tag. A release is unfinished until
the desktop, image and all npm libraries have been verified.

When npm replaces a new package's `0.0.0-stage` placeholder, it can also assign
the first real alpha to `latest` despite `--tag alpha`. The publisher removes
that accidental tag only if no stable version exists. It preserves a valid
stable `latest` and refuses to guess a previous stable version.

To recover this channel-only failure on an immutable older tag, dispatch
`Desktop release` from `main` with `repair_npm_run` set to the original tag run
ID. This mode skips preparation, signing and publication. It binds the original
repository, workflow, tag commit and successful preparation/desktop jobs, then
downloads the retained original npm artifact. Every archive and all published
integrities must match before any tag is removed. Missing/expired artifacts,
newer channels and ambiguous stable versions fail without rebuilding packages.
After repair, rerun only the original failed npm job; it skips identical
published versions and verifies the complete release. Ordinary dispatch with
the input empty still only builds and tests.

The packaged app includes the audited Claude Code and Codex TypeScript
adapters but excludes their large platform packages. If either dependency is
updated, update the matching platform version, tarball URL, and SHA-512 pins in
`src/main/harness-components.ts` for every supported platform, run its focused
tests, and repeat the clean-account first-use checks above.

## One-time npm setup

The npm account must own or have publish access to the `@catamorphic` scope.
Public scoped packages can use npm's free organization plan. First publication
requires that account's authentication; GitHub authentication alone cannot
create the initial npm packages.

Before the first release, use an authenticated npm owner to reserve each new
package name with [staged publishing](https://docs.npmjs.com/staged-publishing/).
Stage a minimal package at `0.0.0` with public access and record its stage id.
npm creates a public `0.0.0-stage` placeholder for a new name. Do not stage the
intended release version: staged and published versions share npm's uniqueness
constraint. The staged `0.0.0` package is never approved or released.

Register trusted publishing with `bun run release:trust`, then reject those
temporary stages by id with `npm stage reject`. The public name reservations
remain, so the tag workflow can publish the verified first release using OIDC.
The helper runs the pinned npm client's `npm trust github` command for all
public libraries; npm may request the owner's two-factor verification.
Registration does not remove or replace an existing trust configuration. For
each package, the trusted publisher is:

- Repository: `opencx-labs/catamorphic`
- Workflow filename: `desktop-prerelease.yml`
- Environment: unset (the npm job already follows the protected desktop job)
- Permissions: direct publication and **Allow npm dist-tag**

Dist-tag management is a separate trusted-publisher permission, disabled by
default. Enable **Allow npm dist-tag** for the same repository/workflow in each
package's npm settings. The pinned CLI's `release:trust` registration does not
grant it. This is one-time owner setup so routine releases and channel recovery
can use OIDC without package-by-package approval. See
[npm's dist-tag permission](https://docs.npmjs.com/trusted-publishers/#managing-dist-tags-with-trusted-publishing).

Verify the first OIDC publication before calling setup complete. npm requires a
new trust configuration's first successful publication within two days; an
unvalidated configuration expires. See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).
Routine releases need no npm token or package-by-package intervention. New
libraries need one-time ownership and trust registration before their first
automatic release too. The root and application manifests, including the
deployed Cloudflare Worker, remain private; all importable framework libraries
publish with public access.

## Work server image

Every release tag also runs `.github/workflows/work-server-image.yml`
([ADR 0159](../../docs/decisions/0159-work-server-identity-and-image.md)). It
builds `apps/server/Dockerfile` natively for `linux/amd64` and `linux/arm64`,
boots each image and checks health, OAuth discovery, the unprivileged user and
the boot banner, then publishes one multi-architecture `work-server` image to
the GitHub Container Registry of the repository owner. Tags are the release
version and `alpha` for every release, plus `latest` for Stable releases. The
workflow attaches a signed build provenance attestation to the image digest.

One-time setup: after the first publication, open the `work-server` package in
the owner's GitHub packages, connect it to this repository, grant this
repository's Actions write access, and set its visibility to public so servers
can pull it without credentials. A manual dispatch of the workflow builds and
smoke-tests both architectures without publishing; run it alongside the
desktop dry run. Verify a published image with
`gh attestation verify oci://<image>:<version> --repo <owner>/<repository>`.

## User install and upgrade

| Channel | Version | Homebrew cask | Update feed |
| --- | --- | --- | --- |
| Stable | `x.y.z` | `opencx-labs/tap/work` | `latest-mac.yml` |
| Preview | `x.y.z-alpha.n` | `opencx-labs/tap/work@alpha` | `alpha-mac.yml` |

Installed builds default to Stable for stable versions and Preview for alpha
versions. The persisted machine-wide choice is available under **Help > Update
Channel**. Switching channels never installs an older version. The app checks
the selected feed shortly after launch, every six hours of wall-clock time
(sleep counts), a minute after wake, and 15 minutes after a failed check. A
check that does not answer within two minutes is abandoned. Update activity
is logged to `~/Library/Logs/Work/updates.log`. It
asks before downloading a release and again before restarting. A release
downloaded before Work last quit is verified again from its cache (or, if
the cache lost it, downloaded again) without asking, and the next prompt
offers Restart. A restart never waits on work:
working agents are handed back and continue after the relaunch, and
terminals end (ADR 0246). DMG users can still install a newer Work app over
the existing copy in Applications.

Before a packaged version first opens an existing PGlite database, it creates
a copy under `data/migration-backups` in the Work application-support
directory. Startup fails rather than migrating without a backup. The app keeps
the two newest pre-migration copies and records success only after the
embedded server has started.
