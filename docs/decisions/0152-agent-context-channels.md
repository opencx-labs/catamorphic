# 0152 — Agent context: a short standing prompt and per-turn context beside the message

- **Status:** Accepted
- **Date:** 2026-09-23
- **Refines:** 0049, 0103, 0133

## Context

A person opened work.software in Work and asked "What is this thing?". The agent
described the empty project's `.catamorphic/` scaffolding, skills and first
commit. The screen snapshot did name the page as active, but only as the last
line of a tab list that the desktop pasted into the person's message, next to
HTML-escaped settings JSON and a peer-session list. The default standing prompt
was 2.9K characters of workflow mechanics that every chat received. The ADR 0103
session facts were an infrastructure JSON dump (Allocation, `bindingId`,
`workerNodeId`) that Claude Code and the built-in agent appended to the system
prompt, so the cached prefix changed every turn. Role names and descriptions
never reached any agent.

## Decision

Agents get two channels, each with one job.

**Standing instructions** stay short, stable and cacheable. Core's default
standing prompt (`STANDING_AGENT_PROMPT`, still replaceable per ADR 0049)
frames general work: the project holds any kind of work, questions about "this"
are about what the person sees, calibrate to the person's role and fluency,
disclose complexity progressively, and load `writing-workflows`,
`workflow-lifecycle`, `building-apps` or `catamorphic-projects` when a task
needs them. The desktop appends one Work section and, when an agent's policy
requires it, one coordination line. Claude Code no longer receives a second
listing of the app skills its plugin already lists.

**Per-turn context** is `TurnOptions.context: TurnContextFragment[]`. Each
fragment has a `source` and a `trust` (`host` facts or `observed` content).
Harnesses deliver it through their native channel, beside the message and
never inside its text or the system prompt:

- Claude Code: the `UserPromptSubmit` hook's `additionalContext`. The first
  prompt of a turn takes it; inputs streamed mid-turn do not repeat it.
- Codex: `turn/start.additionalContext`. Host facts are `application` entries
  and observed content is `untrusted`.
- AI SDK: a system message placed just before the user message
  (`allowSystemInMessages`). It stays in the harness history as the other
  harnesses' transcripts do.

`renderTurnContext` renders fragments as tagged blocks for string channels.
Observed text cannot close its own block.

The fragments are:

- `session` (core): who the person is (host-supplied name and time zone), their
  access, their roles with descriptions, the project, and where commands run.
  Stock memberships describe roles through `MembershipsService.describeMember`,
  and a host's `currentUser` hook may supply them instead. The desktop supplies
  the OS account name and time zone, plus a linked project's roles from `/me`,
  which now returns them. Infrastructure identifiers stay behind `context.read`.
- `workspace` (desktop, observed): the focused surface first, with a passive
  bounded look inside it: a page's title, description, selection and opening
  text; an editor selection; or a terminal's latest output. The look never
  focuses the tab or shows agent activity. It is followed by where the chat
  sits (floating, split, full window, with "just before" resolution) and the
  other tabs.
- `desktop` (host): where private documents go, settings validation errors and
  checkout recovery notices. Settings paths move to the deferred
  `desktop_settings` tool.
- `project_sessions` (observed): other active chats, only when there are some.

Role descriptions become audience guidance. The `catamorphic-projects` skill
asks for who holds a role, what they do, and how technical they are.

Alternatives considered: keeping context in the system prompt (loses caching
and conflicts with 0103's "separately from user messages"), and a synthetic
user message (harnesses treat it as the person's words).

## Consequences

Every harness sees the same facts in its own idiom, and the stored transcript
and harness history keep the person's words intact. `read_tab` joins the
eager surface (0133): a real run showed agents reaching for other browsers
without it. The per-turn cost is a bounded screen description, at most about
1.5K characters of observed text, and it stays in harness history. Remote
desktop chats on linked projects still run as the local root identity; their
roles come from the cached `/me` result and refresh when the project syncs.
