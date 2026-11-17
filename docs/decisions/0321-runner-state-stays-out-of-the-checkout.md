# 0321 — Runner state stays out of the checkout

- **Status:** Accepted (amends 0198)
- **Date:** 2026-11-17

## Context

Every attempt names a `stateDirectory` where the runner and its harness keep
their own files (ADR 0198): Claude Code's copies of pasted media
(`attachments/`), Codex's (`codex-input/`), and, for a sandboxed Codex on the
gateway, its home (`codex-home/`). A sandboxed runner got the sandbox's
`.work-session`. A runner in the host process got the chat's checkout, so on
the desktop every image pasted into a local chat landed in the project
folder. It showed in Git status, as the turn's changed files, in turn
checkpoints and remote sync, against ADR 0142 (caches and staging stay in
host storage) and the composer's rule that a paste is not a project change.

## Decision

A runner's state sits beside the runner and never inside `workingDirectory`:

- **Sandboxed runner:** `<workspaceRoot>/.work-session`, as before.
- **Runner in the host process:** the absolute folder its harness definition
  names through the host hook `stateDirectory({ projectId, sessionId })`,
  which the host removes. The desktop names
  `<userData>/agent-state/<projectId>/<sessionId>` and removes it when
  `NativeAgentCheckout.release` puts the chat away and when the project is
  removed.
- **No hook:** a per-session folder in a private temporary folder of the
  process, made by `mkdtemp` and made anew if anything removed or replaced it.
  Core empties a chat's folder when it releases the resting chat (archived or
  closed), as it does its checkout (ADR 0215).

Core makes no per-session folder: a harness that keeps state makes its own
folders, 0700 with files 0600 like the composer's copy, so an attempt whose
harness keeps none (the built-in agent, ACP) leaves nothing behind. The
choice follows the runner's placement, not whether the chat has a sandbox: a
runner in this process cannot use a sandbox path.

Alternatives: a required hook (every embedder and test harness would name a
folder that only Claude Code and Codex use); a core-level data directory (a
new host option for state that belongs to a runner placement). Both lost
to an optional hook beside `env` and `local`.

## Consequences

Nothing a harness keeps reaches the project, its history or its remote. A
chat at rest loses its copies of pasted media, so a later turn cannot reread
an earlier paste at its old path. Release happens where it already did for
checkouts: a chat still busy when archived keeps its state until the host
removes it (the desktop, with the project). The temporary fallback belongs
to one process: another process neither reuses nor empties it, and nothing
removes its root at exit, so hosts that run Claude Code or Codex in process
should name a folder.
