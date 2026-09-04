# 0089: Project-shaped member shell and session provenance

- **Status:** Accepted
- **Date:** 2026-09-04
- **Refines:** 0043, 0045, 0050, 0055, 0058, 0061, 0081

## Context

The desktop's builder-oriented default exposed source control and manual
server synchronization as equal peers to chats and work products. Invited
members primarily use project agents, documents, presentations, and apps.
Projects also need to onboard different audiences without creating a second
desktop mode, while conversations started through mobile, Slack, Claude, or
another MCP client must remain recognizable in the same history.

## Decision

Projects own their shared sidebar and may declare up to six starting actions
in `.catamorphic/project.json`. The desktop resolves each action for the
caller's `member` or `builder` capability segment before rendering it in the
ordinary New Tab palette. An absent or empty list creates no UI.

The built-in sidebar centers Chats, Files, Apps, and content. Changes and Pull
Requests remain configurable builder surfaces. Remote document transfer is
automatic at project activation and after a saved store file; sharing is a
contextual action in the universal top bar rather than a permanent Server
section. The action is only present for surfaces backed by a real publication
contract; app sharing remains part of the existing app-publication follow-up.

Every agent session records its creation source as `desktop`, `mobile`,
`slack`, `claude`, `mcp`, or `api`. This is informational provenance and never
grants authority. Mirrors and forks preserve it. Clients expose the same
session inspector content from chat chrome and sidebar hover, with a palette
Status command and composer `/status` shortcut.

## Consequences

- Invited members and builders use one adaptable shell instead of role modes.
- Hosts and project authors decide entry actions; the desktop does not encode
  company role names.
- Empty configuration stays visually absent and the command palette remains
  the universal front door.
- External conversations are ordinary durable sessions with visible origin.
- Git and environment detail remains available when the caller is a builder,
  while members are not asked to understand those mechanics.
