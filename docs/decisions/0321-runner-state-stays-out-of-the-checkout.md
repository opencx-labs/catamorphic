# 0321 — Runner state stays out of the checkout

- **Status:** Accepted (amends 0198)
- **Date:** 2026-11-17

## Context

Every attempt names a `stateDirectory` where the runner and its harness keep
their own files (ADR 0198): Claude Code's copies of pasted media
(`attachments/`), Codex's (`codex-input/`), and Codex's home on the gateway
(`codex-home/`). A sandboxed runner got the sandbox's `.work-session`. A runner
in the host process got the chat's checkout, so on the desktop every image
pasted into a local chat landed in the project folder. It showed in Git status,
as the turn's changed files, in turn checkpoints and remote sync, against
ADR 0142 (caches and staging stay in host storage) and the composer's rule
that a paste is not a project change.

## Decision

A runner's state sits beside the runner and never inside `workingDirectory`:

- **Sandboxed runner:** `<workspaceRoot>/.work-session`, as before.
- **Runner in the host process:** the absolute folder its harness definition
  names through the host hook `stateDirectory({ projectId, sessionId })`.
  Core makes it private (0700) before each attempt, and the host removes it.
  The desktop names `<userData>/agent-state/<projectId>/<sessionId>` and
  removes it when `NativeAgentCheckout.release` puts the chat away and when
  the project is removed.
- **No hook:** a per-session folder in a private temporary folder of the
  process, made by `mkdtemp` and made anew if anything removed or replaced it.
  Core removes it when the chat is archived or closed.

The choice follows the runner's placement, not whether the chat has a
sandbox: a runner in this process cannot use a sandbox path. Harnesses
write pasted media 0700/0600, like the composer's own copy.

Alternatives: a required hook (every embedder and test harness would name a
folder that only Claude Code and Codex use); a core-level data directory (a
new host option for state that belongs to a runner placement). Both lost
to an optional hook beside `env` and `local`.

## Consequences

Nothing a harness keeps reaches the project, its history or its remote. A
chat at rest loses its pasted media copies and any Codex home kept there;
its next turn restores the harness's thread from the session's stored
native state (ADR 0198). Hosts that run Claude Code or Codex in process
should name a folder; the temporary fallback does not survive a restart.
