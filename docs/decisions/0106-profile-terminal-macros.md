# 0106 - Profile-owned terminal macros

- **Status:** Accepted
- **Date:** 2026-09-08

## Context

The desktop can launch a shell in a floating panel. A built-in Git launcher
assumes a particular tool and gives one command a privileged global action.
Users need the same convenience for any shell tool or command.

## Decision

Replace the Git-specific launcher in ADR 0105 with `terminalMacros` in the
existing per-profile preferences. Each macro has a stable id, display name,
shell command and optional shortcut. New and existing profiles start with
an empty macro list; legacy default Git settings do not silently install
Lazygit. Users explicitly add the commands they want through Settings.

Each macro contributes one command-palette entry. Normal, floating and tiled
opening use the palette's existing modes. An assigned macro shortcut toggles
its floating terminal. A project reuses the live terminal for that macro id;
only creating a new terminal executes its command in the project folder.
Saving, editing, hiding, expanding, tiling or deleting a macro never executes
commands. Removing a macro does not kill its already open terminal. The
existing close-tab action remains the explicit shell disposal boundary.
No process automatically restarts after quitting the app.

Every new shortcut is configurable per profile, including dismissing a
floating panel (Escape by default). An empty binding disables the action.
The editor detects conflicts across macros and built-in actions. Guests and
terminals use the same shortcut matcher; dismissal is active only while the
surface floats. Dismissal keeps the tab alive and waits for the paired 200ms
exit animation, with reduced-motion support.

## Consequences

This is desktop behavior, with no framework schema or dependency change.
Settings groups controls by category, supports search and has a scrollable
content area that adapts to full tabs and narrow floating panels. Macros do
not impose Git tooling or shortcuts on other users or profiles.
