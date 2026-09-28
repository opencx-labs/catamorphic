# 0184: Personal credentials reach a member's own sessions

- **Status:** Accepted
- **Date:** 2026-09-28
- **Amends:** [0162](0162-connection-gateway-guards-and-sealed-secrets.md), [0175](0175-grants-reach-sandboxes.md), [0180](0180-harnesses-run-in-the-sandbox-models-through-the-gateway.md)

## Context

Developers do real work in remote Environments (workers and sandboxes on
the Work server) and want their own Claude Code and Codex accounts there,
copied from their computer, without logging in again. They also need a few
local files (`.env`, `apps/api/.env.local`) that are never committed.
ADRs 0162 and 0175 keep every credential on the control plane, and 0180
gives server harnesses only an organization model key through the gateway.

## Decision

**Organization credentials still never reach workers or sandboxes. A
member's personal credentials may, into a sandbox that runs only that
member's work:**

- the chat's owner is that member: never a project chat or the project
  principal (so never an automation's delivery into one), and never another
  member's chat; a member's subsessions are theirs;
- the turn's author is the owner: a message they sent, or one that came of
  their own doing through their own call (their chats' agents, a workflow
  they enabled or ran for themselves, their watchers). A message from
  another member, an administrator, or a project automation runs without
  their files, and a chat on their login refuses it: "This chat runs on its
  owner's own Claude Code sign-in, so only they can send it messages.";
- the Environment says `"personalCredentials": true` in
  `.work/project.json` (the implicit `default` Environment does not);
- the placement isolates the member: a microsandbox VM, their own device,
  a worker whose access names only them (ADR 0167), or a machine whose
  operator set `WORK_PERSONAL_CREDENTIALS=accept` (local-process only,
  like `WORK_UNENFORCED_EGRESS`).

Admission checks this with the rest of placement: an agent that runs on a
personal login is refused an Environment that does not allow it, with the
reason and the fix (`EnvironmentIncompatibleError`). Every turn re-admits,
so removing the flag or a machine's access stops delivery on the next turn,
and a turn that may not have them (or finds nothing on the server after
`DELETE`) first takes out whatever an earlier turn placed.

**Storage.** A member's desktop sends, per project, their logins (refresh
tokens removed; the server refuses any it finds) and listed files to
`PUT /projects/:id/personal-environment`; `GET` returns fingerprints,
sizes, expiry, and `needsRefresh` (expires within the hour while a live
chat uses it), never a value; `DELETE` forgets them. Each value is sealed
in the credential vault, one row per (tenant, project, member, kind, name)
(migration 038). Audit rows name entries and fingerprints only.

**Delivery.** At each sandbox turn, after the Git baseline: the login the
agent runs with goes beside the project in the session directory
(`.work-session/home/claude/.credentials.json`,
`.work-session/home/codex/auth.json`, mode 0600) and is rewritten on grant
renewal; files go to their repository paths and into a block Work owns in
`.git/info/exclude`, so sync-back, checkpoints, proposals, and pushes never
carry them. A path the repository tracks, or one reached through a
symbolic link or not a plain file, is left alone and the agent is told;
removal skips such paths too.
A file whose content did not change is not rewritten, so the agent's edits
stay. Close and idle release take everything out; the next sandbox (after
readmission or a move to another Environment) receives it again.

**Harnesses.** `TurnOptions.personalLogin` names the harness and its home.
Claude Code then runs with `CLAUDE_CONFIG_DIR` and no `ANTHROPIC_BASE_URL` or
key helper; Codex with `CODEX_HOME` and its own OpenAI provider. The gateway
path of ADR 0180 is unchanged for `connection` agents. An expired login
fails the turn: "Your Claude Code login on this server has expired. Open Work
on your computer so it can refresh it."

**Agents.** The Work server offers host agents `claude-code` and `codex`
(also as `project:<id>:claude-code`) in projects with an Environment that
allows personal credentials, where the machine has the CLI on its path or
the Environment names an image. Committed definitions may set
`credentials: { "source": "personal" }`. A local Claude Code or Codex chat
moved to the server continues on the matching agent when the member sent
that login; otherwise on the default agent, and the mirror answer's
`agentNotice` says why.

**Local, then remote.** In a connected project every chat is a server
chat (ADR 0098), so "start on my computer, continue on the server" is an
Environment move: a chat on This machine (`device: "member"`) moves to a
server Environment with the chat's Environment control, and the next turn
re-anchors from the saved transcript. A sandbox-resident harness gets the
earlier turns in its instructions, since its own transcript stayed in the
old sandbox. On This machine the CLI comes from the Environment's image:
the member's runner advertises its provider's capabilities (images, image
builds; migration 039; self-reported, which widens nothing since the runner
only takes that member's own work), the desktop builds Dockerfile images when Docker or
Podman is installed, and a create that builds an image may take up to 35
minutes. Every placement boots the Allocation's image, containers and
egress, a member's computer included.

Considered: short-lived copies minted per turn on the member's computer.
Rejected: the desktop is often offline while its chats run.

## Consequences

A login on the server can be used by code in that member's own sandbox
until it expires (hours), which is exactly the member's own reach. Since no
copy holds a refresh token, only the member's computer renews it. Model
usage comes from the harness's own reports, not gateway rows. Operations to
a worker pass through the control plane's job queue: a payload leaves its
row once the worker takes it, but Postgres keeps it in its write-ahead log
until recycled; sealing worker operations end to end is follow-up work.
The Agent SDK terms for consumer logins are a product question the company
is handling separately.
