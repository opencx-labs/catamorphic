# Releasing the desktop app

The desktop release contract is recorded in
[ADR 0082](../../docs/decisions/0082-desktop-prerelease-distribution.md) and
[ADR 0083](../../docs/decisions/0083-desktop-updates-and-migration-backups.md),
with Stable and Preview channels defined by
[ADR 0085](../../docs/decisions/0085-desktop-stable-and-preview-channels.md).
GitHub Releases is the canonical binary source. The Homebrew casks install the
same notarized DMG, and the tap carries the small metadata files packaged apps
use to discover updates.

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

Run the `Desktop release` workflow manually from the intended commit. A
manual dispatch verifies Homebrew tap write access, builds, signs, notarizes,
and verifies the app, then retains the DMG, ZIP, blockmaps, update metadata,
and checksum file as workflow artifacts. It does not create a GitHub release
or change the Homebrew tap.

Install the DMG from the workflow artifact on a clean Apple silicon Mac user
account. Verify:

- Gatekeeper opens Catamorphic without an override.
- Applications shows the Catamorphic icon and bundle identity.
- A `catamorphic://connect` invitation opens the installed app.
- A local project can be created, reopened, and edited.
- Claude Code, Codex, the built-in API harness, terminal, and local sandbox
  paths that are intended for the release all start successfully.
- A remote project can sign in, sync, mirror a conversation, and continue in
  the hosted PWA.
- `LICENSE.txt`, `NOTICE.txt`, and the bundled PWA are present in the app
  resources.
- Help > Update Channel selects Stable or Preview, and Check for Updates
  reports the expected result for each published feed.

## Publish a release

1. Set `apps/desktop/package.json` to the intended version: `x.y.z` for Stable
   or `x.y.z-alpha.n` for Preview.
2. Merge the release change to `main` and wait for CI to pass.
3. Create and push an annotated `desktop-v<version>` tag at that exact commit.

The tag workflow rejects unsupported prerelease names and any tag that does
not match the desktop package version. It then:

1. Builds the repository on an Apple silicon GitHub runner.
2. Signs the app with Developer ID and submits it to Apple's notary service.
3. Verifies the signature, Gatekeeper assessment, stapled ticket, bundle id,
   URL scheme, DMG, and ZIP.
4. Rewrites generated update metadata to the tagged GitHub asset URLs.
5. Creates or updates the GitHub release and uploads the DMG, ZIP, blockmaps,
   update metadata, and SHA-256 checksums. Preview builds are prereleases;
   Stable builds are the latest full release.
6. Generates the applicable Homebrew casks from the released DMG checksum,
   validates their Ruby syntax and style, then advances the casks and channel
   feeds together in the Homebrew tap. Stable releases advance both channels
   so Preview users converge on the vetted build.

The publication steps are rerunnable. Existing release assets are replaced,
and an unchanged cask and feed produce no tap commit. GitHub assets are always
published before the feed points clients to them.

## User install and upgrade

| Channel | Version | Homebrew cask | Update feed |
| --- | --- | --- | --- |
| Stable | `x.y.z` | `opencx-labs/tap/catamorphic` | `latest-mac.yml` |
| Preview | `x.y.z-alpha.n` | `opencx-labs/tap/catamorphic@alpha` | `alpha-mac.yml` |

Installed builds default to Stable for stable versions and Preview for alpha
versions. The persisted machine-wide choice is available under **Help > Update
Channel**. Switching channels never installs an older version. The app checks
the selected feed shortly after launch, every six hours, and after wake. It
asks before downloading and again before restarting, and never restarts while
an agent or terminal is active. DMG users can still install a newer Catamorphic
app over the existing copy in Applications.

Before a packaged version first opens an existing PGlite database, it creates
a copy under `data/migration-backups` in the Catamorphic application-support
directory. Startup fails rather than migrating without a backup. The app keeps
the two newest pre-migration copies and records success only after the
embedded server has started.
