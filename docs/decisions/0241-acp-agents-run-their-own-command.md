# 0241 — ACP agents run their own command

- **Status:** Accepted (builds on [0050](0050-project-agent-definitions.md) and [0198](0198-agent-runners-run-harnesses-beside-their-workspace.md))
- **Date:** 2026-10-17

## Context

ADR 0050 reserved `kind: "acp"` for agents a project brings that are not
one of the host's harnesses, and the desktop answered such a definition with
"not built yet". Hermes Agent and other agents speak the Agent Client
Protocol over stdio (`hermes acp`), so one adapter serves all of them,
where an adapter per agent would repeat every harness switch in the app.

## Decision

`@catamorphic/acp` is a harness adapter (ADR 0198) that runs one process
per attempt from the definition's `acp.command` in the chat's checkout and
speaks ACP over its stdio with the official SDK. The agent keeps its own
configuration, model and sign-in (`modelAccess: host`). The desktop runs it
for an approved project definition; approving one runs its command on
this machine, so the consent dialog names the command, and the consent
hash already covers it.

- **Sessions** stay with the agent: the first turn opens one in the
  checkout, later turns reopen it with `session/load`. Native state is
  `none`, so a chat moved to another machine starts fresh with a handoff.
  The harness id is `acp:<command name>`, so a chat stays with its agent.
- **Work's tools** (workspace tools, `ask_user`) reach the agent as a
  loopback MCP server per attempt behind a bearer only that agent is
  given, decided by the attempt's tool policy. Servers the attempt names
  pass through as ACP MCP servers.
- **Instructions and context** have no ACP channel. They ride the prompt
  as blocks of their own (`<work-instructions>` on a new session's first
  turn, `<work-context>` every turn), apart from the person's words.
- **The agent's permission requests** become Work approvals. "Always"
  picks the agent's own persistent option.
- **Interrupt** is `session/cancel`; an agent that ignores it is stopped.
  ACP has no steer, so a message sent mid-turn restarts the attempt with
  it.

**Hermes is also an agent of the person's own.** Settings' setup wizard
offers Hermes beside Claude and ChatGPT: it finds the install on PATH or
in `~/.local/bin` (where Hermes' installer puts it) and adds an agent of
harness `hermes` that runs `hermes acp` through the same adapter. Nothing
is approved, since the person set it up; when Hermes is missing the wizard
shows Hermes' own install and setup commands. Work never downloads it (a
Python install cannot be integrity-pinned like ADR 0091's components) and
offers no model, effort or key fields for it: those stay in Hermes
(`hermes model`, `hermes setup`). Its harness id is `hermes`, so its chats
stay with it; a project's ACP agents are `acp:<command name>`.

Considered: Hermes' TUI gateway protocol, which adds steering, questions and
branching. It is Hermes' own and changes with it; ACP is the seam ADR 0050
chose and covers other agents too.

## Consequences

A person adds their Hermes in Settings in one step, and a project can
commit `{"kind": "acp", "acp": {"command": ["hermes", "acp"]}}` for its
members to approve. Each turn starts the agent's process. A host tool call that waits longer
than the agent's own MCP timeout (Hermes: five minutes) fails on its side.
Still open: the `acp.endpoint` transport, ACP agents on the Work server
(the agent must be in the sandbox image), model choice through ACP, and
streaming the agent's plans and usage.
