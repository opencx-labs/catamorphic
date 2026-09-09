# 0111: Direct desktop configuration editing

Status: Accepted

## Context

ADR 0110 added settings-specific agent tools alongside editable files. The desktop
is local-first, and the user prefers direct file editing during alpha. Ordinary
file operations already express the work; a second mutation interface is redundant.

## Decision

Remove the settings read/update tools. Supply exact configuration paths, owning
profile, access mode and validation errors through live per-turn agent context.
Ship schemas, inheritance and reset semantics through the existing desktop host
skill. Agents use ordinary file/shell facilities and respect their native permissions.
An unavailable host filesystem must be stated explicitly, never replaced by a
sandbox mirror. This is desktop doctrine; core remains host-neutral.

UI and external edits use the same files and validators. Invalid known values or
malformed JSON retain the file's last valid configuration and report its path in
Settings and agent context. A first invalid load uses defaults until repaired.
Deletion resets a file or key to inheritance. Sidebar documents remain JavaScript
and replace a complete layer. Credentials remain host setup flows.

## Consequences

There is one configuration interface. Agents can customize the app without bespoke
tools; validation belongs at the file boundary. Context paths are metadata, never
permission grants. ADR 0110's settings catalog and palette navigation remain valid;
its settings-specific tools are superseded.
