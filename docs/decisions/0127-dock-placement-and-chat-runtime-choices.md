# 0127: Dock placement and chat runtime choices

- **Status:** Accepted
- **Date:** 2026-09-11
- **Refines:** 0121

## Context

Users want both centered and edge-aligned expanded chats. A collapsed dock should
move between corners without becoming a freely positioned overlay. Fresh chat
inspectors also need the same runtime controls as established conversations.

## Decision

Add profile preference `dockAlignment`: `edge` (default) or `center`. It positions
the expanded bubble strip and floating chat within the workspace, or within the
display for a detached dock. `dockSide` remains the collapsed bottom corner.
Drag the collapsed bubble or expanded handle horizontally; release snaps to the
nearest side. Persist only the side, never coordinates. Escape cancels, arrow
keys choose a side, and settling respects reduced motion.

All chat presentations use the same editable model and reasoning inspector.
Before session creation, choices live on the draft chat and become session
overrides on first send. Existing sessions use their normal update operation.
A chat picker never edits agent defaults. Busy or unsupported controls explain
why they are unavailable. Dismiss the inspector before opening its picker.

## Consequences

Dock presentation remains desktop-owned, independent of execution. The framework
accepts the model override at session creation alongside the existing effort
option. Tests cover fresh and established chats, unchanged agent defaults,
pointer cancellation, both corners, centered placement and detached windows.
