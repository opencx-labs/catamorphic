# 0280 — Terminals use the project theme and chat workspace

- **Status:** Accepted
- **Date:** 2026-10-24
- **Builds on:** [0209](0209-people-reach-their-sandboxes.md), [0215](0215-a-chats-own-worktree.md)

## Context

The person found a purple terminal inside an amber project and a shell opened
from a worktree chat starting in the project folder. The terminal appearance
provider captured the profile's theme above project scopes; terminal creation
only carried a chat reference for remote shells. The person asked for a clean
unification without compatibility code.

## Decision

Keep the existing resolved theme boundary as the source of app colors and fonts.
The terminal appearance provider loads the profile's source selection and optional
Ghostty configuration. Its consumer hook derives app appearance from the nearest
`ThemeScope` and waits for it before opening a terminal. No terminal-specific
theme resolver or copied project settings are introduced.

Use one chat reference for local and remote user terminals: the session ID and
whether its workspace runs on the server. Main resolves a local session through
the existing `SessionCheckouts` service at creation; a remote one uses the existing
remote terminal backend. Reopened terminals retain that reference and resolve the
current assignment. Do not persist a duplicate working-directory path or silently
fall back when an assigned worktree is unavailable. Group attachment remains a
separate presentation concern. The remote-only field is replaced, with no legacy
decoder.

## Consequences

New terminals match the project around them and open beside the chat's work.
Existing local shells still move between windows without restarting. The embedded
terminal engine fixes its color palette at open time, so running shells retain
their colors; fonts can update live. Explicit Ghostty appearance stays a profile
choice.
