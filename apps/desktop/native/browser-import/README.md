# macOS browser import helper

`bin/browser-keychain` is a prebuilt universal arm64/x86_64 executable (134 KiB),
minimum macOS 11. It links only system Foundation, Security, LocalAuthentication, and CommonCrypto.
Normal install, dev, build, test, and package commands **do not compile it**.
Only macOS packages copy it into `Contents/MacOS/browser-keychain`.

To update the helper, on a Mac with the Xcode command-line tools:

```sh
bash apps/desktop/native/browser-import/test.sh
bash apps/desktop/native/browser-import/build.sh
```

Keep the source, binary, and generated `manifest.json` together. Unit tests check
the source/binary SHA-256 pins so source edits cannot silently ship an old helper.
The development artifact has an ad-hoc signature. electron-builder's macOS
`binaries` list signs it with the release identity before app notarization;
validate a Developer ID signed package before distributing a release. Release
signing changes the artifact bytes; the manifest checks the repository prebuild,
not the signed installed executable. The OS validates installed code signatures.

## Protocol and authorization

Arguments are non-secret Keychain service/account names selected by main from
the browser registry and checked against a native allowlist. Every invocation
requires device-owner authentication (Touch ID or Mac login password), even if
Keychain access was previously granted with Always Allow. The helper makes one `SecItemCopyMatching` read (no key
creation, access-group entitlement, ACL change or privilege elevation). macOS
may prompt the user to authorize access. Success writes exactly 16 derived-key
bytes into main's child-process pipe. It refuses a terminal stdout. Exit 2 means
user cancellation, 3 missing key, 4 denied/unavailable, 64 invalid invocation.
`--version` is safe to run without accessing Keychain. Never run the real import
command in a terminal or log its output.

The Chromium v10 algorithm is specified by the upstream source:
https://chromium.googlesource.com/chromium/src/+/38c29b6535f88af0bbe843e0416390018d965da6/components/os_crypt/sync/os_crypt_mac.mm
Main uses read-only SQLite (including live WAL data), supports local and account
login stores, and decrypts only recognized v10 records. Existing destination
accounts win. Unknown encryption formats are reported as failures and never
silently treated as plaintext. No password export or temporary database is made.

## Browser coverage and Owl investigation

Chrome, Edge, Opera, Brave, Arc and Chromium use explicit registry entries.
Edge and Opera lead the non-Chrome Chromium desktop share; Brave is the next
major cross-platform choice with macOS support. Samsung's desktop browser is
Windows-only (https://browser.samsung.com/).

Read-only inspection of the installed ChatGPT app's Owl 152.0.7977.83 framework
on 2026-09-11 found `browser_profile_importer.cc` labels for Chrome and Atlas,
including Atlas Alpha/Beta/Debug, and a rejection of other source types. Its
Atlas key lookup explicitly requires Owl's OpenAI Keychain access-group
entitlement. We do not replicate or bypass that access. Atlas, Firefox, and
Safari/Apple Passwords require portable export instead of direct import here.

The helper is too small to justify a separate downloadable release, hosting,
cache, first-use network failure, and update lifecycle. The existing harness
downloader handles published third-party npm tarballs hundreds of megabytes in
size; reusing it would still require publishing this new artifact. Bundling only
on macOS keeps imports offline and adds zero binary bytes to other packages.

## Verification

`test.sh` compiles a separate synthetic native test against a mocked Keychain
function. It verifies success, denied/missing/cancelled responses, key derivation,
and exact read-only query shape without reading personal credentials. Normal
TypeScript tests exercise the checked-in prebuild's version/invalid invocation,
SQLite fixtures, decryption, duplicate handling, cancellation and platform gates.
Real Keychain prompt UX must also be smoke-tested with a Developer ID signed
release; synthetic tests do not claim to verify the user's installed browsers.

### Signed release smoke

The macOS packaging workflow runs `bun scripts/desktop-signature.ts <app>` on
the packaged app. It requires valid Developer ID signatures on both the app and
helper, the same signing team, both helper architectures, and protocol version 1.
The probe invokes only `--version` and does not read Keychain.

For interactive verification on a Mac with Chrome installed:

1. Download and extract the signed macOS workflow artifact. A manual workflow
   dispatch builds an artifact without publishing a release.
2. Run `bun scripts/desktop-browser-import-smoke.ts prepare` from the repository
   root. Keep its temporary `profileDir` and the printed synthetic credential.
3. Launch Chrome with `--user-data-dir=<profileDir> --no-first-run
   --no-default-browser-check --disable-sync chrome://password-manager/passwords`.
   Keep this profile signed out. Add exactly the printed website, username and
   password using Chrome's password manager, then close that disposable browser.
4. Run `bun scripts/desktop-browser-import-smoke.ts verify <signed app>
   <profileDir> import`. Complete device-owner authentication and approve the
   signed helper's Keychain request when macOS asks.
5. Repeat with `cancel`, cancelling device-owner authentication, then `existing`,
   which must skip the duplicate without requesting authentication.
6. Remove the disposable profile after verification.

The runner refuses any profile without its marker or with a different login
inventory. It uses the production read-only SQLite reader and signed helper,
checks the decrypted test value in memory, and verifies the source database did
not change. Output contains only signature identity and result counts. It never
prints a Keychain key or real credential. Its destination is an in-memory test
sink; the isolated desktop E2E suite separately covers the settings and vault
integration. Passing synthetic tests is not evidence that this interactive smoke
has been completed.

### Recorded smoke: 2026-09-12

Verified on the developer's arm64 Mac, macOS 26.5.2 (25F84), using Chrome
154.0.8037.17 and a signed-out disposable profile containing only the synthetic
login above. The user completed authentication and cancelled the second prompt.
The signed artifact came from [workflow run 34647341399](https://github.com/opencx-labs/catamorphic/actions/runs/34647341399),
main commit `491ba79464ada93c27d003e43ab4443953e42b8c`; its native helper source and
prebuild are unchanged by this cleanup. The production reader came from this
worktree. Artifact checksums passed, both signatures identified team
`JV46H2AQV2`, both helper architectures were present, and local Gatekeeper
assessment returned `Notarized Developer ID`.

| Scenario | Imported into test sink | Existing | Cancelled | Source unchanged |
| --- | ---: | ---: | --- | --- |
| Authenticate and import | 1 | 0 | No | Yes |
| Cancel authentication | 0 | 0 | Yes | Yes |
| Skip destination duplicate | 0 | 1 | No | Yes |

All three reported zero invalid records and zero failures. Duplicate handling
finished without authentication. The import checked the exact decrypted test
password in memory. Chrome held its password database locked while open;
quitting the disposable instance released it, matching the production reader's
existing instruction to close the source browser. This verifies the signed
helper and production reader on arm64, not execution on an Intel Mac or a manual
round trip through the settings UI and persistent destination vault.
