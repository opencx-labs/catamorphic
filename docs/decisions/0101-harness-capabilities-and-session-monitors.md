# 0101: Harness capabilities and session monitors

- **Status:** Accepted; source retirement superseded by [0123](0123-session-artifacts.md)
- **Date:** 2026-09-07
- **Refines:** 0045, 0074, 0076, 0090, 0091

## Context

Native harnesses must retain useful file, shell, media, and skill capabilities.
Private harness todo lists, delegation, and monitoring compete with the host's
visible session state. Temporary monitoring must use the existing workflow
model and must not alter the user's working checkout.

## Decision

Keep each harness's native execution tools within the selected permission mode.
When the host supplies the equivalent durable session capability, use its todo
list, subsessions, and watchers. Native shell replacement remains an explicit
embedder option; the desktop keeps native shell tools available. Disable native
Claude Monitor and Codex goals in the desktop, alongside private delegation.
These choices remain injectable provider options for other hosts.

A session monitor is an ordinary expiring workflow enablement (ADR 0076).
Use registered Project Events for existing ingress, or a normal schedule trigger
and workflow IO for periodic checks. A Monitor provider is needed only for a
shared normalized event source. Code chooses whether to report, wake, or remain
silent. Placement determines which running host can execute it.

Publish temporary source from an isolated disposable origin checkout. Stop,
expiry, and session close/archive disable future activations. Existing runs keep
their immutable source. Under ADR 0123, results remain with the retained session;
discard/session deletion removes refs after runs settle, with retry state in Postgres. Closing a chat tab alone does not close the
session. External polling requires a live, unexpired watcher, uses a bounded
request, and is aborted and joined on worker shutdown.

## Consequences

- SDK/CLI pins are tested at their real protocol boundary using loopback model
  and MCP fixtures, without model credentials.
- Transport retry diagnostics cannot mark a subsequently successful turn failed.
- Image/document staging lasts for one turn and is removed on all exit paths.
- Permission modes remain explicit. Codex workspace-write protects `.agents`,
  `.codex`, and `.git`; a denied skill edit must not silently change the agent
  to full access. Hosts may expose authorized project editing separately.
