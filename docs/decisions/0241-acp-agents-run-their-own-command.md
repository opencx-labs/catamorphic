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
this machine, so every place that approves names the command (each
argument whole, hidden characters spelled out), the consent hash already
covers it, approval binds only the definition the person reviewed, and an
ACP definition needs its member's approval whatever its `credentials`
say. Approval covers the definition, not files in the checkout its
command runs: as with Claude Code's project hooks (ADR 0045), a
collaborator can change those after approval. The agent runs with Work's
environment, as a command in the person's own terminal would.

- **Sessions** stay with the agent: the first turn opens one in the
  checkout, later turns reopen it with `session/resume` when the agent
  offers it (nothing replayed), else `session/load` (its history replayed
  and ignored). Work hears of a session only once it holds the
  conversation and can be reopened: a new session after its first turn
  completes, never one from an agent that cannot reopen sessions, so Work
  hands that agent the whole conversation each turn instead. A session the
  agent refuses to reopen (deleted, pruned) is replaced by a new one,
  reported at once, rather than failing every later turn; that one lacks
  the earlier conversation, since a harness cannot yet tell core its
  thread is gone.
  A restart on a thread Work never heard of starts the turn's input over:
  core's restart rule (ADR 0240) now carries only what no thread took in
  just when the attempt continues the thread. Native state is
  `none`, so a chat moved to another machine starts fresh with a handoff.
  A turn ends once the agent's process has exited, so a session the agent
  saves on exit is saved before the next turn reopens it. The harness id
  is `acp:<agent id>`, one per agent, so a chat stays with its agent.
- **Work's tools** (workspace tools, `ask_user`) reach the agent as a
  loopback MCP server per attempt behind a bearer only that agent is
  given, decided by the attempt's tool policy, over HTTP even when the
  agent does not advertise HTTP MCP (Hermes takes it without saying so).
  Servers the attempt names pass through as ACP MCP servers.
- **Instructions and context** have no ACP channel. They ride the prompt
  as blocks of their own (`<work-instructions>` on a new session's first
  turn, `<work-context>` every turn), apart from the person's words.
- **The agent's permission requests** become Work approvals. "Always"
  picks the agent's own persistent option; a one-time answer never
  becomes it: offered no "once", an approval is a refusal and a refusal
  cancels the request.
- **Interrupt** is `session/cancel`, which withdraws the agent's waiting
  permission requests; an agent that has not ended its turn ten seconds
  later is killed with everything it started (its process group, so the
  agent behind an `npx` or `sh -c` command goes too). ACP has no steer, so
  a message sent mid-turn restarts the attempt with it.

**An ACP agent can also be the person's own.** A profile agent of harness
`acp` stores the command it runs, and runs through the same adapter and
the same registry path as a project's. Settings' setup wizard offers
Hermes as a preset beside Claude and ChatGPT: it finds the install on
PATH or in `~/.local/bin` (where Hermes' installer puts it) and adds an
ACP agent running `hermes acp`. Nothing is approved, since the person set
it up; when Hermes is missing the wizard shows Hermes' own install and
setup commands. Work never downloads it (a Python install cannot be
integrity-pinned like ADR 0091's components) and offers no model, effort
or key fields for an ACP agent: those stay in the agent (for Hermes,
`hermes model` and `hermes setup`). The app knows Hermes only by its
command, for its icon and those hints; every other ACP agent is shown as
itself.

Considered: Hermes' TUI gateway protocol, which adds steering, questions and
branching. It is Hermes' own and changes with it; ACP is the seam ADR 0050
chose and covers other agents too.

## Consequences

A person adds their Hermes in Settings in one step, another ACP agent is
a preset away, and a project can
commit `{"kind": "acp", "acp": {"command": ["hermes", "acp"]}}` for its
members to approve. Each turn starts the agent's process. A host tool call that waits longer
than the agent's own MCP timeout (Hermes: five minutes) fails on its side.
Still open: the `acp.endpoint` transport, ACP agents on the Work server
(the agent must be in the sandbox image), model choice through ACP,
streaming the agent's plans and usage, a way for a harness to tell core its
thread is gone (so a replaced session gets the whole conversation), a
stdio bridge for agents that take no HTTP MCP, and keeping a thread's
process warm between turns.
