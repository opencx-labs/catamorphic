# 0093: Session model overrides and the desktop toolchain

- **Status:** Accepted
- **Date:** 2026-09-06

## Context

Changing a model from a chat must affect that conversation without changing
other chats using the same agent. Native desktop agents also need Bun when
launched from Finder, which does not inherit a developer's terminal PATH.

## Decision

Persist an optional model override on the ordinary agent session, alongside
its reasoning override. Null inherits the current agent default. Forks copy
the override; switching agents clears it. The existing per-turn harness
options carry it, without creating another agent configuration.

The inspector distinguishes the selected model from the last model reported
by the harness, and effort controls reflect the shipped adapter's supported
scale and clamping. Unknown provider capabilities are not advertised.

Extend the verified first-use component store from ADR 0091 to Bun. Native
harness startup and every agent-owned desktop terminal ensure the runtime is
installed before spawning. Prepend its directory after shell profiles run.
Workflow execution sandboxes retain their existing Bun runtime.

Use bounded executable discovery instructions. Do not wrap filesystem
utilities in an incomplete access-control shim: they break valid commands
and cannot enforce a sandbox boundary.

## Consequences

Per-chat choices survive restarts without mutating shared agents. First-use
native execution requires a network connection; the verified cache works
offline afterward. Bun updates require a release with reviewed integrity pins.
