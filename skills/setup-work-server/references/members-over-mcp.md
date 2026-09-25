# Working from your own agent

Use this when a member wants to work on a Work server project from Claude
Code, Codex, or any other MCP client instead of (or beside) the Work app
(ADR 0166). Everything runs as the member, with their project roles.

## Connect

The project's MCP address is `<server>/api/projects/<projectId>/mcp`
(stateless Streamable HTTP). A member finds the project id in the Work app,
in an invitation link (`project=`), or from whoever set the project up.

- Claude Code: `claude mcp add --transport http work <server>/api/projects/<projectId>/mcp`,
  then `/mcp` and sign in. Add `--scope project` to share the entry with a
  repository's collaborators; each person still signs in as themselves.
- Other clients: add the same address as a remote HTTP server.

The client discovers sign-in from the server's 401, registers itself, and
opens the server's sign-in page (company sign-in or local password). Access
tokens last 15 minutes and refresh while the member stays active and in the
company; a member removed from the directory loses access within minutes.
Never paste a token into a configuration file.

At `initialize` the server sends instructions that name the tools this
member has. `project_overview` answers the rest: roles, permissions, agents,
Environments, workflows, apps, and the member's draft.

## What each role can do

The same address serves everyone. Some tools are listed only to roles that
can use them; the rest are listed to every member and refuse what the role
does not allow:

| Member holds | Tools |
| --- | --- |
| Any role | `project_overview`, `documents_*` (reads what the role may read; writes and deletes only the `store/` paths it may write), `list_skills` / `read_skill`, `ask_agent` for their agents, `workflow_run` / `workflow_runs` / `run_details` for their workflows, every deployed `ai.tool-call` workflow as its own tool, `propose_change`, and the share tools (which need `publications:write`, or `publications:read` for `shares_list`) |
| `program:write` | `program_files`, `program_write`, `program_check` (their private draft) |
| `program:write` and `program:publish` | `program_deploy` |

## The builder's loop

1. Read `catamorphic-projects`, `writing-workflows`, and `building-apps` with
   `read_skill`. A project with no `.catamorphic/workflows/package.json`
   needs the workspace first: copy the support files that
   `catamorphic-projects` lists with `program_files` and `program_write`.
2. `program_write` the workflow or app. Nothing reaches others yet.
3. `program_check` refreshes generated types (the trigger kinds this server
   offers, app API types) and validates the draft: parse errors, trigger
   kinds and configuration, and imports it can see. It is not a full
   TypeScript check; keep code simple, and check locally when you have a
   clone. Fix every error.
4. `program_deploy` with a commit message. It builds and publishes every app
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

`ask_agent` runs a project agent on the server and returns its reply. It runs
on the member's own machine when the operator gave them one, otherwise on a
team or shared machine; pass `environment` to choose another Environment
(`project_overview` lists them and what each runs for you).
Continue a conversation with its `sessionId`; the same chat appears in the
Work app. Server agents reach connected systems, such as a read-only
production database, through the gateway with guard review
([secrets and the gateway](secrets-and-gateway.md)). A member's own client
never receives those credentials; ask a project agent instead. An action a
guard escalates waits for approval in the Work app.

## Sharing with customers

`share_create` with `kind` (`document`, `folder`, or `app`), `target`, and
an `audience` of emails or domains returns the link to send; app shares also
name the `environment` its workflows run in. See [sharing](sharing.md).

## When something fails

- 401 after a while: sign in again from the client (`/mcp` in Claude Code).
- "Your roles do not allow that": the role lacks the permission; ask a
  project manager, who changes `.catamorphic/roles/*.json` through review.
- `ask_agent` answers that no Environment satisfies the workload: the
  project has no Environment for agents that this member may use and that
  is online. Check `project_overview`, the role's `environments`, and the
  workers (`GET /_work/operator/machines` on the server).
- `program_deploy` returns `blocked`: its `findings` are `program_check`
  errors.
