# Agent Checkout Coordination Design

## Status

Approved in conversation on 2026-08-23.

## Purpose

Let multiple agents work on one project without forcing every conversation
into a Git worktree. Agents see other active work, inspect peer sessions, and
choose whether to share the current checkout, wait, or move to an isolated
worktree. The same behavior must work across the built-in, Claude Code, Codex,
and future harnesses.

## Product principles

1. The first agent works in the normal project folder. Creating a chat never
   creates a worktree by itself.
2. A later agent receives project-scoped context about other active sessions
   before it acts.
3. The agent makes the semantic choice. Catamorphic supplies awareness and a
   worktree mechanism; it does not infer file ownership.
4. Sessions that deliberately share a checkout also share its files, Git
   state, checkpoints, commits, and rollback boundary.
5. Worktrees are optional and role-sensitive. Non-technical roles normally
   stay in the visible project folder. Engineering roles normally prefer
   isolation when concurrent work may interfere.
6. Catamorphic owns top-level checkout selection. Harness-native top-level
   worktree switching must not compete with the host.
7. Peer visibility defaults to the current project. Cross-project discovery
   requires an explicit host capability. Incognito sessions are excluded by
   the desktop before any peer context reaches an agent.

## Vocabulary

- **Checkout:** the directory a session currently edits. It is either the
  primary project folder or a Git worktree.
- **Primary checkout:** the user-visible project folder.
- **Managed worktree:** a worktree Catamorphic created and may later clean up
  after recovery checks.
- **External worktree:** a worktree created by a user, IDE, Claude Code,
  Codex, T3 Code, or another harness. Catamorphic may adopt it but never
  removes it automatically.
- **Coordination strategy:** role doctrine controlling what the agent normally
  chooses when peers are active: `shared-first`, `isolate-on-contention`, or
  `isolation-required`.

“Workspace” is not introduced as a product or domain concept.

## Session awareness

At the start of every turn, the desktop adds a compact `<project_sessions>`
block beside the existing workspace context. It lists other sessions in the
same project that are currently running, waiting, or recently active, with:

- session id and title;
- running or idle state;
- latest user request as a bounded task summary;
- current human-readable activity when the agent has published one;
- primary or worktree checkout and branch;
- coordination strategy relevant to the current agent.

The later-starting agent owns the immediate coordination decision. Existing
agents are not interrupted mid-tool-call merely to announce a newcomer. Their
next turn receives the updated peer snapshot, and they can inspect peers at
any time.

Harness-neutral tools provide deeper access:

- `list_project_sessions`: compact project-scoped session summaries;
- `read_project_session`: a bounded transcript for one visible peer session;
- `set_session_activity`: publish or clear a short description of current
  work so later agents do not have to infer it from a long transcript;
- `use_project_checkout`: explicitly keep sharing the primary checkout;
- `create_worktree`: create and bind a managed worktree for this session;
- `use_worktree`: validate and bind an existing worktree belonging to the
  same Git repository;
- `list_worktrees`: list primary, managed, and external worktrees.

The built-in and Claude Code harnesses receive these as extra tools. Codex
receives the same definitions through a session-scoped loopback MCP endpoint,
because the Codex SDK exposes MCP servers rather than an in-process custom
tool hook.

## Visibility and privacy

The core service exposes peer summaries and transcripts only after the same
project and identity-scope checks used by normal session APIs. Builders may
read project peers. Scoped members may read only sessions whose agent refs
their scope covers and that the host has made peer-visible.

The desktop performs its local privacy filter before supplying peer context:

- incognito sessions are neither listed nor readable by agents;
- the current session is omitted from its peer list;
- full transcripts are never injected automatically;
- transcript tools are capped and paginated;
- cross-project listing is absent by default.

A future supervising agent may receive tenant-wide discovery through an
explicit host capability. It is not part of the default tool surface.

## Role doctrine and policy

Profile agents and committed project-agent definitions gain a coordination
strategy:

- `shared-first`: prefer the primary folder when work appears independent;
- `isolate-on-contention`: prefer a worktree when another writing agent is
  active, but allow a deliberate shared choice;
- `isolation-required`: do not edit a checkout already used by another active
  editor.

Absent configuration defaults to `shared-first`, preserving the product's
general-purpose and non-technical posture. The desktop agent configuration
surface exposes the setting in plain language. Committed project agents use
the same enum in `agents/<slug>.json`.

The strategy is doctrine. The tool mechanics remain identical across roles.
`isolation-required` is the only hard policy; the other strategies guide the
agent and allow judgment.

## Shared-checkout semantics

Choosing the same checkout is an explicit decision to share state:

- no file locks or per-agent ownership records;
- no per-agent staging or change attribution;
- no independent rollback promise;
- normal filesystem last-write-wins behavior if the agents misjudge overlap;
- broad operations such as branch switching, reset, restore, and dependency
  rewrites must be coordinated by the agents.

ADR 0044 already defines checkpoints as whole-checkout snapshots rather than
authorship claims. That rule remains. Catamorphic adds only a mutex around
checkpoint Git operations for a common Git directory. If two turns settle at
the same time, commits serialize; the first may include both agents' current
changes and the second may be empty. A rollback is checkout-wide and the UI
must describe it that way.

## Checkout binding

Sessions begin on the primary checkout without a persisted special binding.
Once a session creates or adopts a worktree, the desktop stores a local
session-to-checkout binding. Filesystem paths remain host-owned desktop state;
they do not enter Catamorphic's shared schema or mirrored transcripts.

Core replaces the project-only host path callback with a session-aware
checkout resolver receiving `{ projectId, sessionId }`. Hosts that do not
support worktrees return their normal project path.

The desktop manager:

- uses the system Git binary;
- discovers worktrees with porcelain output and canonical paths;
- creates managed worktrees under a hidden, locally excluded project
  directory so host harness sandboxes can reach the new checkout during the
  initiating turn;
- names managed branches under `catamorphic/`;
- validates that adopted worktrees share the project's common Git directory;
- records managed versus external ownership;
- never deletes external worktrees;
- never removes a managed worktree while it is dirty, active, or its branch
  lacks a recoverable ref.

When `create_worktree` or `use_worktree` succeeds during a turn, it returns the
absolute checkout path and explicit instructions to use that path for all
remaining file and terminal operations. Subsequent turns start with that path
as their native harness working directory. The session stays on that
worktree until explicitly returned to the primary checkout.

## Harness behavior

### Claude Code

Catamorphic continues to withhold Claude Code's top-level `EnterWorktree` and
`ExitWorktree` tools. The neutral workspace tools are the sole top-level
owner. Claude's worktree-isolated subagents remain allowed because they are
internal children, not a reassignment of the Catamorphic session.

### Codex

The desktop exposes the neutral tools through a session-scoped local MCP
server and supplies the resolved checkout path as `workingDirectory` on every
turn. No Codex-native worktree lifecycle is assumed.

### Built-in and sandbox harnesses

They receive peer awareness and session-reading tools. Worktree tools report
unavailable unless the host can bind that sandbox session to an alternate
checkout. The desktop must not create a host worktree for an agent that is
actually editing a remote or per-user sandbox.

### Future harnesses

Adapters receive the resolved directory. If a harness later adds native
top-level switching, the adapter must mask it or translate the request into
the host checkout manager. Two top-level owners are never active.

## Checkpoints, sync, and review

Host-execution checkpoints operate against the resolved checkout using system
Git. This is necessary because linked worktrees are a system-Git feature and
the existing project manager opens only the primary dev copy. Checkpoint
operations serialize by common Git directory.

Primary-checkout turns retain automatic remote sync. Worktree turns do not
silently sync the project's main branch. A worktree agent shares through an
explicit pull-request or integration action. Git read surfaces continue to
show every worktree.

## Failure handling

- Missing system Git: peer awareness and shared editing remain available;
  worktree tools return an actionable unavailable result.
- Dirty or invalid external worktree: adoption is rejected with the exact
  reason and no binding changes.
- Worktree creation failure: remove only the partial managed directory/ref
  created by the failed operation; never touch pre-existing paths or refs.
- Stale binding: validate it before each turn. If missing, fall back to the
  primary checkout and inject a recovery warning.
- Concurrent checkpoint requests: serialize, then re-check dirty state. An
  empty second checkpoint is success, not an error.
- Shared-file collision: ordinary filesystem and Git recovery behavior. No
  automatic merge or ownership inference.

## UI

The desktop does not introduce a workspace selector. Existing chat and Git
surfaces gain only contextual labels:

- chats on the primary checkout need no badge;
- isolated chats show their branch/worktree in the chat surface and session
  list;
- agent configuration exposes the coordination strategy with role-oriented
  descriptions;
- rollback or destructive Git actions warn when multiple active sessions
  share the checkout;
- externally created worktrees are labeled “External” and never offer
  automatic removal.

Non-technical users can remain entirely in the project folder without seeing
worktree terminology.

## Testing

Tests cover:

- project-scoped visibility and transcript authorization;
- running-state and bounded task-summary generation;
- incognito filtering in the desktop bridge;
- strategy parsing for profile and project agents;
- prompt rendering for no peers, shared peers, and isolated peers;
- managed creation, external adoption, common-directory validation, branch
  collision handling, and stale-binding recovery in temporary Git repos;
- session-aware path resolution for Claude Code and Codex;
- whole-checkout checkpoint serialization and empty-second-commit behavior;
- Codex session MCP wiring;
- desktop end-to-end behavior with two fake agents sharing the primary
  checkout and one choosing a worktree.

## Documentation

The change updates ADRs, the desktop design log, agent-definition examples,
the desktop workspace playbook, and relevant project/host skills. Documentation
must state that shared checkout commits and rollback are shared by design.
