# Working from your own agent

Use this when a member wants to work on a Work server project from Claude
Code, Codex, or any other MCP client instead of (or beside) the Work app
(ADR 0166). Everything runs as the member, with their project roles.

## Connect

The server has one MCP address for everything a member runs on it:
`<server>/api/mcp` (stateless Streamable HTTP). It serves `project_list`
and the chat tools, with the project as an argument, so one entry starts,
watches and answers coding agents in every project the member may use.

- Claude Code: `claude mcp add --transport http work <server>/api/mcp`, then
  `/mcp` and sign in. Add `--scope project` to share the entry with a
  repository's collaborators; each person still signs in as themselves.
- Codex and other clients: add the same address as a remote HTTP server.

A project also has its own address, `<server>/api/projects/<projectId>/mcp`,
which adds that project's documents, program and workflows to the same chat
tools. Add it when the member builds in that project. A member finds the
project id with `project_list`, in the Work app, or in an invitation link
(`project=`).

The client discovers sign-in from the server's 401, registers itself, and
opens the server's sign-in page (company sign-in or local password). Access
tokens last 15 minutes and refresh while the member stays active and in the
company; a member removed from the directory loses access within minutes.
Never paste a token into a configuration file.

Both addresses speak the current protocol revision (2026-07-28) and the
earlier handshake revisions, so any client connects. The server sends
instructions that name the tools this member has. On a project's address,
`project_overview` answers the rest: roles, permissions, agents,
Environments, workflows, apps, and the member's draft.

## What a client is granted

The sign-in page lists what the client may do, and the member unticks what
they do not want it to have. A client that asks for nothing is offered
everything below except approving and full access, ticked. Every client
holds the member's roles narrowed by the scopes it was granted, over MCP and
the API alike, and is shown only the tools they cover:

| Scope | Lets the client |
| --- | --- |
| `work:full` | Full access as the member, approving included. The Work app and the phone ask for it; it is one line to allow or deny |
| `work:read` | Read projects, documents, chats and runs |
| `sessions:run` | Start, message, answer, stop and close chats, and run workflows |
| `sessions:approve` | Approve or deny what an agent asks to do. Never ticked for you |
| `documents:write` | Write and delete documents in the project store |
| `program:write` | Change a draft of the project's program |
| `program:publish` | Publish program changes and shared links |

A client without a token is told to ask for `work:read sessions:run`. A call
that needs more answers 403 with the scope to ask for, and the client signs
in again for it. A sign-in from before scopes existed names none: it is
refused, and its client signs in again.

## What each role can do

The same address serves everyone. Some tools are listed only to roles that
can use them; the rest are listed to every member and refuse what the role
does not allow:

| Member holds | Tools |
| --- | --- |
| Any role | `project_overview`, `documents_*` (reads what the role may read; writes and deletes only the `store/` paths it may write), `list_skills` / `read_skill`, the chat tools (`session_start`, `session_wait`, `session_answer` and the rest) for their agents, `workflow_run` / `workflow_runs` / `run_details` for their workflows, every deployed `ai.tool-call` workflow as its own tool, `propose_change`, and the share tools (which need `publications:write`, or `publications:read` for `shares_list`) |
| `program:write` | `program_files`, `program_write`, `program_check` (their private draft) |
| `program:write` and `program:publish` | `program_deploy` |

## The builder's loop

1. Read `work-projects`, `writing-workflows`, and `building-apps` with
   `read_skill`. A project with no `.work/workflows/package.json`
   needs the workspace first: copy the support files that
   `work-projects` lists with `program_files` and `program_write`.
2. `program_write` the workflow or app. Nothing reaches others yet. The
   draft lives on the server, private to you, and one call's changes land
   together; every replica sees them, and none loses them on restart.
3. `program_check` refreshes generated types (the trigger kinds this server
   offers, app API types) and validates the draft: parse errors, trigger
   kinds and configuration, and imports it can see. It is not a full
   TypeScript check; keep code simple, and check locally when you have a
   clone. Fix every error.
4. `program_deploy` with a commit message publishes the draft as one commit,
   merging what others published meanwhile. It builds and publishes every app
   the change touches and reports each app's build result; a failed build
   keeps the app's previous version. Projects whose program is
   published from GitHub change through pull requests there, or
   `propose_change`.
5. `workflow_run` with a JSON input, then `run_details` for a longer run. A
   workflow with an `ai.tool-call` trigger is a tool on the next
   `tools/list`, for everyone whose role grants it.

A member without `program:publish` drafts the same way and ends with
`propose_change`.

## Agents, workers, and production systems

A chat is a project agent working on the server. The member's own agent
controls it with eight tools, the same operations the Work app, the API and
workflows use:

| Tool | Does |
| --- | --- |
| `session_start` | Starts a chat with its first message and returns its `sessionId` at once. `ref` starts the workspace at a branch or pull request |
| `session_wait` | Returns when a chat is `idle`, `failed`, `needs_input` or `closed`, within 50 seconds. `changed: false` means nothing happened yet: call it again with the same `cursor` |
| `session_answer` | Answers a question the agent asked (`needs_input` lists `requests`) |
| `session_send` | Sends a follow-up: queued, steering the turn in progress, or interrupting it |
| `session_read` | Reads the reply, typed results, pull requests, and on request the transcript, usage or a turn's attempts |
| `session_interrupt` | Stops the turn in progress; the chat stays open |
| `session_close` | Ends the chat and releases its workspace |
| `session_list` | Lists the member's chats with their state |

The loop is: `session_start`, keep working, `session_wait` with the returned
`cursor`, then read or answer. Every changing call takes an
`idempotencyKey` (any unique string): repeated after a timeout, it returns
the first result, so a chat is never started twice or lost. A turn that
fails is `state: "failed"` with its `error`. A chat still waiting for a
machine says so in `waiting`. The same chat appears in the Work app.

The agent runs on the member's own machine when the operator gave them one,
otherwise on a team or shared machine; pass `environment` to choose another
Environment (`project_overview` lists them and what each runs for you).
Server agents reach connected systems, such as a read-only production
database, through the gateway, reviewed by any guards the company added
([secrets and the gateway](secrets-and-gateway.md)). A member's own client
never receives those credentials; ask a project agent instead.

When an agent asks something, the chat needs its person: the Work app and
the phone show it and send a notification. Questions are the client's to
answer. An approval (an action a guard or a tool policy escalates) is the
member's own: it waits in the Work app unless the member granted their
client `sessions:approve`.

Clients that support more get more, with nothing else to learn:

- A client that declares the tasks extension gets a task from
  `session_wait` and polls `tasks/get`; the task asks for input as an
  elicitation and ends with the chat's state. Cancelling it stops the
  watching, never the agent.
- A client that can ask its person (elicitation) and passes
  `onInput: "ask"` to `session_wait` is asked the agent's question in the
  same call.
- `work://sessions/<sessionId>` reads as the chat's state and
  `work://attention` lists the chats that need the member; a client that
  listens (`subscriptions/listen`) hears when either changes.

## Sharing with customers

`share_create` with `kind` (`document`, `folder`, or `app`), `target`, and
an `audience` of emails or domains returns the link to send; app shares also
name the `environment` its workflows run in. See [sharing](sharing.md).

## When something fails

- 401 after a while: sign in again from the client (`/mcp` in Claude Code).
- 403 naming a scope: the client was not granted it. Sign in again and
  tick it.
- A tool call fails with `{"error":{"code","message","retryable"}}`:
  `retryable` says whether calling again with the same `idempotencyKey`
  can help.
- "Your roles do not allow that": the role lacks the permission; ask a
  project manager, who changes `.work/roles/*.json` through review.
- `session_start` answers `environment_unavailable`: the project has no
  Environment for agents that this member may use and that is online. Check `project_overview`, the role's `environments`, and the
  workers (`GET /_work/operator/machines` on the server).
- `program_deploy` returns `blocked`: its `findings` are `program_check`
  errors.
