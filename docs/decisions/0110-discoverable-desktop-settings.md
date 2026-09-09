# 0110: Discoverable desktop settings

Status: Accepted. Agent tools superseded by [ADR 0111](0111-direct-desktop-configuration.md).

## Context

The palette opens Settings but cannot locate individual controls. Project agents
cannot read repository-internal guidance, and the old mirror-file adapter is unused.

## Decision

Maintain a shared desktop catalog of settings search terms and stable destinations.
Use it for ordinary palette results, the `settings` scope and agent reference material.
Navigation reuses the Settings surface, reveals the destination and focuses its
control without modifying its value. Search is local, bounded and independent of
live settings reads.

Ship desktop configuration guidance through the existing hostSkills hook, never as
framework doctrine. Read and update tools use the initiating project's owning
profile and the same validated stores as the UI. Mutations are unavailable to
read-only agents. Remove the unused mirror adapter rather than reviving a second
configuration transport. Host authentication and credential entry remain host UI.

## Consequences

Settings, palette rows and agent guidance evolve together. New settings need a
stable target and catalog entry. Existing user-authored project skills are preserved;
current desktop guidance is distributed at the host tier on every boot.
