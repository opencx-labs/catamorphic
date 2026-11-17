# 0322 — Agents on a server start subagents, which share their workspace by default

- **Status:** Accepted (amends 0090, 0202, 0278)
- **Date:** 2026-11-17

## Context

Only the desktop served `spawn_subsession`, so an agent in a server's
sandbox (Claude Code, Codex, ACP; ADRs 0180, 0198, 0255) used its
harness's own subagents, which Work cannot see (ADR 0202: "Server hosts
still offer no delegation tool"). A subsession also always got its own
admission, Allocation, sandbox, setup and a checkout of the project
default: a pull request review that fans out 12 to 18 reviewers over one
prepared checkout would admit 18 machines. And a child whose later turn
produced its result (its own background command woke it) never told the
parent: a delegation reports only while it is running, and its first
settled turn ends that. The PR reviewer worked around both with a child
cap wrapper and an idle hook.

## Decision

**Core serves the subsession tools.** `spawn_subsession`,
`wait_for_subsessions` and `interrupt_subsession` have one definition in
core (`subsessionTools`). Core serves them, as host calls like `ask_user`,
to every agent whose host serves none of them: agents placed in a sandbox
(Claude Code and ACP see them as MCP host tools, Codex as dynamic tools)
and a server's built-in agent. The desktop builds its own from the same
definition. Grants (0090, 0271) and `maxConcurrentChildren` apply as
before; the cap is checked before anything is admitted, fetched or made.

**A child shares its parent's workspace unless it asks for its own.**
Spawn takes `workspace: "shared" | "own"`, default `shared`, on every host.

- `shared`: the child records `workspace_session_id`, the session whose
  workspace it works in (its parent's, or the one its shared parent works
  in). It carries that session's Allocation, sandbox, Environment and base,
  copied at spawn and followed before each of its turns: no admission,
  Allocation, sandbox or setup of its own, and whatever the parent's
  checkout holds. Its turns run beside the parent's, each attempt its own
  runner process; the runner's state sits in
  `.work-session/subsessions/<id>`. The workspace's Git and HTTP grants
  are issued in the workspace session's name, its model grant is its own
  attempt's (0293). Its changes sync into the workspace session's copy and
  its checkpoints are commits there, one workspace's sync at a time under a
  replica claim. Making and setting up a sandbox workspace's build is one
  session's at a time too, under a replica claim on its Allocation, every
  sandbox workspace's since a turn cannot know who else will arrive: the
  first runs the whole setup step, and its outcome (the build it ran in and
  its note to the agent, failures included) is recorded on the Allocation, so
  a session that arrived meanwhile reuses it and starts once it ends, instead
  of running it again; a child that may not rebuild the workspace for a
  setup on its own network is told that last outcome. Work under these
  claims stops once its claim could be lost. Idle release counts the
  workspace in use while any session in it works; a child whose workspace
  was released admits it again for that session. Closing or archiving the
  child gives back only its own grants and state; closing the parent closes
  it as before. A shared child's files are not rewound; the parent's are not
  while a sharer has queued, held or running work, and a sharer's turns wait
  while they are. A delivery cannot move a shared child's base. On
  the desktop it works in the parent's checkout: the project folder, as
  every child did, or the parent's own worktree. A child whose agent cannot
  run there (a folder for a sandbox agent or the reverse, a contained
  workspace for an agent whose changes leave its sandbox, an Environment or
  connection the Allocation lacks) is refused, naming `own`.
- **One owner per shared workspace.** Sharing a workspace is working beside
  its agent (0209): anyone but the workspace session's owner needs workspace
  access to start a shared child, and the child is the workspace session's
  owner's. The owner's secrets, personal files and setup reach the
  workspace only while every turn working in it was written by that owner;
  otherwise they are taken out, and the owner's turns working beside are
  told.
- `own`: today's admission and workspace, started at the parent's base
  (its ref and commit, pinned for the child, ADR 0178) where it has one.

A shared writer edits the parent's files; the tool and the delegation
guidance say so, and parallel writers take `own`. Read-only children keep
their harness's read-only mode.

**A child's later results reach the parent.** A child's turn started by
anything but a person (its parent, its own background command, a watcher
or workflow) makes its delegation running again, and each settled turn
reports to the parent once, keyed by the turn, through the steer path
(0278) or as the idle parent's next turn. Turns a person starts in the
child's chat are theirs and do not report, and a child its parent stopped
stays stopped. A delegation running again counts against the parent's
`maxConcurrentChildren`: new spawns are refused while the limit is reached,
but the child is never refused its own turn, so the count can pass the
limit until it settles.

Considered: a workspace forked from the parent's per child (a sandbox and
setup each: what the reviewer avoids); one runner process multiplexing
sessions (a second protocol, when per-attempt processes already coexist);
children's own grants in `grants/<alias>` (a closed child would leave the
newest grant dead where the parent reads it).

## Consequences

Server agents delegate as desktop ones do and Claude Code there loses its
native Agent tool (`hostOwnsSubagents`). Every turn's eager schemas grow by
about 200 bytes. A review fans out over one
checkout with one setup and one machine slot. Each sandbox turn's
preparation takes one claim, uncontended unless another session works
there; whatever runs in the setup step runs under it. Shared writers interleave
edits and checkpoints in one history. A rebuild of the workspace (a base
move, ADR 0257) ends runners beside it; their turns recover as lost
attempts do (0198). A person's later conversation with a child stays out
of its parent's turns.
