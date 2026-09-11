# 0130 — Prebuilt macOS browser password import helper

- **Status:** Accepted
- **Date:** 2026-09-11

## Context

Users want direct browser password imports without adding native compilation to
ordinary desktop builds. ADR 0079 chose CSV to avoid a browser fork. The user
approved a standalone, prebuilt macOS helper and platform-specific settings.

## Decision

Keep the existing main-process credential broker and profile vault. A small
Objective-C executable retrieves a selected browser's Safe Storage secret with
device-owner authentication on every invocation plus macOS Keychain authorization,
and returns the derived Chromium encryption key
through a private child-process pipe. Main reads the selected profile's SQLite
login stores read-only, decrypts supported records, and imports them into the
vault. No secrets cross renderer IPC, enter logs, or become temporary exports.
Existing destination accounts are preserved; counts distinguish added, existing,
invalid, and unsupported/decryption-failed records.

Support Chrome, Edge, Opera and Brave on macOS 11+ (arm64/x64), plus Arc and
Chromium using the same format. Samsung's desktop browser is Windows-only.
Owl's installed importer recognizes Chrome and Atlas, including Atlas channels;
its Atlas key retrieval explicitly requires OpenAI's private Keychain access
group. We do not offer Atlas direct imports or try to bypass that entitlement.
Firefox and other browsers retain CSV import.

Build a universal helper only when its source changes, retain source and pinned
build metadata, and bundle it only in macOS packages. It uses system frameworks
and no Electron ABI. Normal builds copy and release-sign it. The helper is tiny;
lazy fetching would require a new published artifact and availability lifecycle
for negligible savings, so use the user's authorized bundling fallback.

## Consequences

Direct imports need macOS authorization, but no compiler or network on first
use. Platform capability is enforced in main and represented in settings; CSV
and bookmark imports remain portable. Browser encryption changes may require a
helper or TypeScript update. Unknown formats fail closed with visible counts.
This supersedes only ADR 0079's CSV-only password import decision.
