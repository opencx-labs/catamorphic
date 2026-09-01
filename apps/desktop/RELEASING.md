# Releasing the desktop app

The desktop release contract is recorded in
[ADR 0082](../../docs/decisions/0082-desktop-prerelease-distribution.md) and
[ADR 0083](../../docs/decisions/0083-desktop-updates-and-migration-backups.md).
GitHub Releases is the canonical binary source. The Homebrew cask installs the
same notarized DMG, and the tap carries the small metadata file packaged apps
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
4. Create a `desktop-release` GitHub environment in this repository. Protect
   it with required reviewers if release publication should require a manual
   approval.
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

Run the `Desktop prerelease` workflow manually from the intended commit. A
manual dispatch builds, signs, notarizes, and verifies the app, then retains
the DMG, ZIP, blockmaps, update metadata, and checksum file as workflow
artifacts. It does not create a GitHub release or change the Homebrew tap.

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
- Help > Check for Updates reports that the installed dry run is current or
  finds the expected newer alpha channel release.

## Publish a prerelease

1. Set `apps/desktop/package.json` to the intended prerelease version.
2. Merge the release change to `main` and wait for CI to pass.
3. Create and push an annotated `desktop-v<version>` tag at that exact commit.

The tag workflow rejects stable versions and any tag that does not match the
desktop package version. It then:

1. Builds the repository on an Apple silicon GitHub runner.
2. Signs the app with Developer ID and submits it to Apple's notary service.
3. Verifies the signature, Gatekeeper assessment, stapled ticket, bundle id,
   URL scheme, DMG, and ZIP.
4. Rewrites generated update metadata to the tagged GitHub asset URLs.
5. Creates or updates the GitHub prerelease and uploads the DMG, ZIP,
   blockmaps, update metadata, and SHA-256 checksums.
6. Generates `Casks/catamorphic.rb` from the released DMG checksum, validates
   its Ruby syntax and Homebrew style, then advances the cask and
   `updates/alpha-mac.yml` together in the Homebrew tap.

The publication steps are rerunnable. Existing release assets are replaced,
and an unchanged cask and feed produce no tap commit. GitHub assets are always
published before the feed points clients to them.

## User install and upgrade

```bash
brew install --cask opencx-labs/tap/catamorphic
brew upgrade --cask opencx-labs/tap/catamorphic
```

Installed builds also check the alpha channel shortly after launch, every six
hours, and after wake. The app asks before downloading and again before
restarting. It never restarts while an agent or terminal is active. Help >
Check for Updates runs the same check on demand. DMG users can still install a
newer Catamorphic app over the existing copy in Applications.

Before a packaged version first opens an existing PGlite database, it creates
a copy under `data/migration-backups` in the Catamorphic application-support
directory. Startup fails rather than migrating without a backup. The app keeps
the two newest pre-migration copies and records success only after the
embedded server has started.
