# 0166 — Members work from their own agents over the project MCP

- **Status:** Accepted
- **Date:** 2026-09-25
- **Refines:** 0042, 0055, 0164, 0165

## Context

Members of a project on a Work server use Claude Code, Codex, or other MCP
clients as much as the Work app. The project MCP (ADR 0055) let them read
documents, propose changes, and ask the project's agents, but not do the
work a builder does in the app: change workflows and apps, check them,
publish them, run them, and read what happened. Workflows exposed as tools
(ADR 0042) were served only by the desktop, so a project built there lost its
tools on the server. Clients received no orientation at `initialize` and had
to discover the loop by trial.

## Decision

**The project MCP carries the member's whole working loop**, with the
member's identity and roles, through the same core services as REST:

- `project_overview`: the project, the caller's roles and permissions,
  agents, Environments (what each runs for this caller), workflows, apps, and
  the caller's draft.
- `program_files`, `program_write`: the caller's draft of the program (their
  dev branch). A clean draft follows what is published; a draft with edits
  keeps them and publishing merges.
- `program_check`: refreshes generated types and validates the draft as
  publishing does (`checkProject` with the server's trigger kinds).
- `program_deploy` (`program:publish`): publishes the draft, refused while
  the check has errors and for projects whose program is published from a
  linked repository (those change through pull requests or
  `propose_change`).
- `workflow_run`, `workflow_runs`, `run_details`: run a deployed workflow
  as the caller and debug its runs.
- `ask_agent` takes an Environment, so a member chooses where a server agent
  runs (for example an enrolled worker).

**`ai.tool-call` is a framework trigger kind** in `@catamorphic/server-sdk`
(`aiToolCall`, `aiToolKind`). Every host that registers it serves the same
workflow tools; the Work server does.

**Hosts extend the endpoint** through `projectMcp` on the Fastify plugin:
the server name, a paragraph for the orientation, and host tools that see the
caller's identity. The Work server adds its shares (`share_create`,
`shares_list`, `share_revoke`). Every client receives `instructions` at
`initialize`, naming only the tools that caller has.

Considered: serving Git over HTTP so members clone the program. It needs a
second credential path and a long-lived token for Git, and it duplicates what
the draft already is. Projects whose program lives on GitHub keep cloning
from GitHub.

## Consequences

Anyone with a role can work from their own harness: an engineer builds and
publishes a workflow and an app, a customer success manager updates customer
documents and shares them, and neither holds a credential beyond their own
sign-in. Production systems stay behind the gateway (ADR 0162); a member
reaches them by asking a project agent. Structured tool results are always
JSON objects, as MCP clients validate them. Where each piece of work runs
follows its owner (ADR 0167).
