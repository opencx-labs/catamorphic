# 0182 — Sandboxing and permission modes are different settings

- **Status:** Accepted
- **Date:** 2026-09-27
- **Supersedes:** the normalized `mode` of 0056; the `mode` naming of 0176
- **Refines:** 0050, 0140, 0180

## Context

ADR 0056 gave agents one normalized `mode` (`read-only | edit |
full-access`) and mapped it onto each harness's own permission setting.
ADR 0176 then reused that `mode` for a Work boundary: what may leave an
agent's sandbox. One word now named two settings, and people could no longer
choose a harness's native mode at all: Claude Code's `auto` or `dontAsk`,
or Codex's approval policy, had no way in.

## Decision

Two settings, with clearly different names.

**Sandboxing** is Work's, enforced by core on every host: what may leave the
agent's sandbox. `contained` lets nothing leave (no checkpoint, sync back,
store upload, proposal, or push through the gateway; connection actions only
read). `propose` (the Work server default) may propose changes and use what
its bindings grant for its own work, but not deploy or publish. `publish`
may do everything bindings and roles allow. Capabilities declare the
narrowest sandboxing that may call them (`sandboxing: "publish"` on deploy,
publish, and revoke). Refusals say `This agent's sandboxing is contained: ...`
and what to do instead. Types: `SANDBOXING_LEVELS`, `Sandboxing`,
`sandboxingAllows`, `sandboxingRefusal` in `@catamorphic/sandbox`.

**Permission mode** is the harness's own, in its native values, set per
harness in `harnessPermissions`: Claude Code takes `permissionMode`
(`default | acceptEdits | plan | auto | dontAsk | bypassPermissions`);
Codex takes `sandbox` (`read-only | workspace-write | danger-full-access`)
and `approvals` (`untrusted | on-failure | on-request | never`); the
built-in agent takes none, since its tool policies cover the same ground.
Definitions and the desktop agent store validate the fields against the
harness. Core hands a definition's settings to the harness on every turn
(`TurnOptions.harnessPermissions`), so one server harness instance serves
agents with different modes. `bypassPermissions` passes the SDK's
`allowDangerouslySkipPermissions`, and inside a Work sandbox also
`IS_SANDBOX=1`. Library defaults stay: Claude Code `acceptEdits`; Codex
`workspace-write` on the host and `danger-full-access` in a Work sandbox.
Desktop local agents keep ADR 0140's freedom: `publish`,
`bypassPermissions`, Codex `danger-full-access` with approvals on request.

The settings are independent. Claude Code in `bypassPermissions` inside a
`contained` sandbox is valid: fast inside, nothing leaves. Both are in the
definition consent hash (ADR 0050), so widening either re-earns consent.

A nested `harnessPermissions` object was chosen over top-level fields so the
harness-native names never sit beside Work's, and over a union keyed by
`kind` so one definition shape serves every harness.

## Consequences

Old `mode` fields are dropped without a shim: a committed definition's
`mode` is stripped as an unknown key, and existing desktop agents fall back
to the local defaults until someone picks again. The desktop shows
"Permission mode" in each harness's names and "Sandboxing" apart, in the
configure-agent modal and the chat inspector, with a palette command to
change a profile agent's permission mode; committed and server definitions
show read only. The agent catalog carries each agent's declared sandboxing
and permission settings. On the desktop, where a local agent works in the
project folder, `contained` also withholds host tools that act for the
person and settings edits. A per-chat permission mode override is not part
of this decision; the setting belongs to the agent.
