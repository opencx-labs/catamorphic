# 0300 - Electron trust belongs to native-created documents

- **Status:** Accepted; legacy local-storage import superseded by [0301](0301-internal-origin-storage-starts-clean.md)
- **Date:** 2026-11-01
- **Refines:** 0079, 0211, 0220, 0277

## Context

The desktop combines native operations, signed-in browsing, and untrusted app
documents. Session-wide API credential injection also authorized app iframes.
IPC callers and auxiliary windows lacked a single document admission boundary,
and some secure-storage failures could fall back to another credential source.
The alpha hardening is authorized to preserve existing interaction and data.

## Decision

Work-owned renderers use the Chromium sandbox and a restricted internal origin.
Main registers each native-created document and its channel grants before load.
Privileged IPC requires its live main frame, expected document, and resource
ownership. Browsing ownership can be read from prepared sessions but never grants
shell authority. Guest preloads and security preferences are enforced in main.

Only an admitted workspace or dock main frame receives the desktop API token. Untrusted app
documents and project PDF previews use revocable, document-only capabilities on
a separate scheme. Guest content receives no general API credentials. MCP app
mounts bind their original chat, profile, stable connection and resource; current
policy and schema are checked before dispatch and before releasing results.

Saved credentials and approval keys require secure OS storage. Unavailable or
unreadable secrets fail with recovery guidance; metadata and recovery remain
available. Production Electron fuses restrict alternate launch/code-loading
paths, encrypt cookies, and verify the application archive. Browser debugging is
rejected in distributed builds. Development and isolated test tools remain usable.

## Consequences

The internal-origin transition starts with separate local UI storage (0301);
legacy values remain on disk without automatic import. Existing browser, app, terminal,
voice and passkey interactions require native regression coverage. Each mount's
authority ends on close, owner document replacement or profile change. These
desktop policies remain outside the embeddable framework's default identity.
