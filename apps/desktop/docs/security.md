# Desktop security boundaries

Work is a native desktop host with browser pages and user-built apps. These
surfaces have different authority; sharing an Electron session grants none.
The accepted design is [ADR 0300](../../../docs/decisions/0300-electron-trust-boundaries.md).

## Native documents and IPC

The workspace, detached dock, passkey sheet and voice pages use sandboxed,
isolated renderers. Packaged UI loads from `work-internal://shell`, whose handler
serves only built renderer assets. Native registrations bind the expected live
main-frame document and its IPC channels. Auxiliary pages have explicit grants.
Browsers and extension windows never become shell callers by owning a profile.
Terminal, download, vault and project operations additionally check ownership.

Main enforces browsing guest partitions, preloads and security settings. Guest
notifications, login capture, passkeys, extensions and dictation retain their
specific validated protocols; they do not use the shell's general bridge.

## Local API and guest documents

The embedded API stays on loopback. A per-launch token is attached only to
admitted workspace and dock main-frame traffic to that API origin and is
stripped elsewhere. Auxiliary pages use their limited native channel grants.
Browser-stamped requests without it are refused; Host validation prevents DNS
rebinding. Explicit OAuth return routes validate their own authorization state.
Native local-program trust remains as defined in [ADR 0211](../../../docs/decisions/0211-the-desktop-api-refuses-web-pages.md).

App HTML and project PDF previews use `work-guest` document capabilities, separate
from the privileged API. Each app mount owns a grant, including when the same app
appears in several places. These handlers expose no arbitrary proxy or filesystem
route. App iframes retain their opaque-origin sandbox and declared network CSP.
MCP mounts retain their original profile, project, chat, stable connection and
resource identity. Calls validate live policy and schema across asynchronous
boundaries. Close, owner reload, profile change and connection revocation end
access; late results are withheld from replacement documents.

## Credentials and distribution

Credential persistence requires OS-provided secure storage. Linux `basic_text`
and unknown backends are refused for real profiles. Unavailable storage and
unlock failures preserve existing encrypted data, explain recovery, and never
silently select another account. Settings can enumerate metadata and replace a
broken key without first decrypting it. Legacy plaintext project-agent bindings
must be reconnected. Test plaintext encryption is limited to unpackaged Linux
tests with disposable profiles; it cannot enable a production fallback.

Distributed binaries disable Electron-as-Node, Node environment options and
inspectors, enable cookie encryption and ASAR integrity, and restrict loading to
the application archive. Extra `file:` privileges are disabled. Chromium remote
debugging switches are rejected separately. The release verifier checks actual
binary fuse values before distribution; signing and notarization remain required.
See [release verification](../RELEASING.md).

The internal origin starts with separate local UI storage. Old file-origin
drafts and interface preferences remain on disk without automatic import.
Projects, chat history and the application database are unaffected. See
[the alpha storage decision](../../../docs/decisions/0301-internal-origin-storage-starts-clean.md).
