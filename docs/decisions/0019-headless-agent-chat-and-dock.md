# 0019 - Agent chat is headless state plus a controlled dock

- **Status**: accepted
- **Date**: 2026-07-21

## Context

The playground rendered its coding-agent conversation as a fixed right
sidebar that owned API hooks, session orchestration, layout, and message
presentation. That consumed editor width and made the experience difficult for
hosts to reuse or restyle.

## Decision

Agent chat is split across package boundaries:

- `@catamorphic/react` exposes `useAgentChat(projectId)`, which owns lazy
  session creation, message sending, project cache invalidation, project
  changes, and combined request state.
- `@catamorphic/ui` exposes controlled `AgentChatDock`, which receives
  messages, status, errors, and callbacks. It has no API client or project
  knowledge.
- Hosts own placement and domain-specific message metadata. The playground
  installs the `agent-chat` registry item, passes `projectId`, and positions
  it horizontally at the bottom of its editor.

The dock is collapsed by default. Its compact bar keeps the composer available
and shows only authoritative working state or the latest assistant event or
message. Expanding reveals the conversation without replacing the active
session.

## Consequences

- Hosts can build a different chat surface over the same headless hook or use
  the controlled dock with their own state layer.
- The editor canvas no longer loses width to a permanent chat sidebar.
- The synchronous send endpoint persists one in-progress assistant message and
  updates it after discrete command, edit, tool, text, and error events. The
  headless hook polls only while a turn is active.
- The dock includes narrow-screen and reduced-motion behavior, while exact
  viewport positioning remains a host responsibility.
