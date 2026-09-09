# 0109: Desktop transitions and scoped settings

Status: Accepted

## Context

Workspace navigation and chat delivery have accumulated independently updated
state. Desktop preference families have different scopes, and ordinary layout
preferences have no project overrides or inheritance reset.

## Decision

Keep workspace identities, transitions, normalization and persistence projection
in a pure desktop module. Host effects perform IO and animation; delayed
completion can only finish the transition that initiated it. Rendering, attention
and navigation derive from the same materialized surface identities.

Keep chat delivery transitions in the headless React package. Server execution
and inbox state remain authoritative; local delivery and connectivity are distinct.
No desktop navigation or Electron dependencies enter the reusable chat contract.

Ordinary configurable preferences resolve per key: built-in default, profile,
shared project, then personal project override. A setting declares its valid scopes
and validator. Reset deletes an override so subsequent lower-layer changes flow
through. Runtime state, credentials and enforced policy are not preference layers.
Sidebars retain whole-document resolution and themes their token resolution;
their different merge semantics are explicit contracts, not generic object spreads.

## Consequences

Transition tests complement native Electron interaction tests. Settings expose
the selected scope and effective source without duplicating the same controls.
Current interaction contracts live separately from the historical design log.
