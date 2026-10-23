# 0278 — Subagent updates reach the turn and read as activity

- **Status:** Accepted (extends 0240 and replaces 0250's parent delivery rule)
- **Date:** 2026-10-23

## Context

A parent turn can run for hours while a subagent sends progress with
`message_only`. Those updates wait unread until another turn, so the parent
fetches the child's transcript to learn its result. Meanwhile each update
occupies a separate row in the person's conversation. Delivery and visibility
have become coupled even though the agent and the person need different views.

## Decision

A direct child's messages join its parent's working turn through the existing
steer path, regardless of the requested dispatch. They do not stop that turn.
The harness's existing `input.consumed` acknowledgement marks them read; reading
another transcript is never required for delivery. Owner isolation and authority
checks still apply. With no working parent, context-only messages remain context;
ordinary messages and results can start a turn as before.

Delivery does not dictate presentation. Routine agent messages and successful
subagent task updates are work items in the existing activity log, grouped by
their source chat into a compact expandable status. Their full text and source
links remain available there. Attention requests, failures and questions that
need the person stay visible in the conversation. People's messages remain
conversation messages and steer the active turn immediately by default.

Use the existing typed session log, dispatch modes, task statuses, attention
flags and activity disclosures. Do not add a second inbox, acknowledgement
protocol, persisted presentation setting or compatibility path.

## Consequences

Parents receive progress while they work without polling transcripts or losing
their current task. Routine updates no longer fill the person's conversation.
All clients derive the same activity projection from the existing log. Explicit
interrupt delivery between peer chats keeps its meaning; a child reporting to a
working parent cannot interrupt it.
