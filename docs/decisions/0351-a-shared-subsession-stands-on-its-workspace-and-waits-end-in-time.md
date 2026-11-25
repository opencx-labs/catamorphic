# 0351 — A shared subsession stands on its workspace, and a tool's wait ends before the agent's client gives up

- **Status:** Proposed
- **Date:** 2026-11-25
- **Amends:** 0241, 0264, 0271, 0322, 0323

## Context

A production pull request reviewer moved onto Work as project code: a
coordinator in a project chat starts about twenty subsessions in its own
workspace (ADR 0322), each submits typed results (ADR 0323), and a workflow
counts verifier votes whose commit is the pull request's head. Its first runs
on a Work server failed in four ways, none of them the project's doing.

- Every vote was stamped with the project's published `main`. A turn's
  checkpoint was read from the copy of the session's own id. A shared
  subsession keeps no copy, so opening one cloned `main`, and the result's
  commit (ADR 0323) was that clone's HEAD, never the workspace's.
- A child whose agent declares an optional connection was refused the shared
  workspace when the parent's Allocation had not been given it, though
  admission itself leaves an unavailable optional connection out (ADR 0181).
  The agent fell back to `workspace: "own"`, whose provisioning is slow.
- `wait_for_subsessions` holds a call for up to 60 seconds, which is exactly an
  MCP client's default request timeout. An ACP agent is served Work's tools
  over MCP (ADR 0241), so its client gave the call up as the answer arrived.
- The coordinator's grants name two other agents and no copy of itself, but the
  spawn tool's schema and the standing instructions said to leave `agent` out
  for a copy, so its first spawns were refused.

## Decision

**A shared subsession's turn stands on its workspace session's copy.** The
turn's checkpoint, the base a result's commit is derived from, and the base a
setup on its own network is seeded with are read from the workspace session
(`workspaceCopyId`, `workspaceBaseOf`), as saves and rollbacks already were.
A shared child's results carry the commit its parent's do, and no stray copy
is made for it.

**A shared workspace asks only for the connections a child requires.** An
optional requirement the workspace was not given is left out, as admission
leaves it out of a workspace of its own. A required one still refuses, naming
`workspace: "own"`.

**Every wait in a Work tool ends before the agent's client would give the call
up.** A registered agent may say how long its client waits for a tool call's
answer (`RegisteredCodingAgent.toolTimeoutMs`). For a call of such an agent the
host fires the tool's `stopWaiting` signal (ADR 0264) a quarter of that time
early, 15 seconds at most, counted from when it read the call, and the result
says the wait ended early, so the agent waits again if it still needs to. Because the limit rides the one
signal every waiting tool already honors (`waitUntil`), it covers
`wait_for_subsessions`, the desktop's waits and any a host adds, with no change
to them. ACP agents default to 60 seconds, the MCP SDK's own, so Work holds a
call 45; a definition says otherwise with `acp.toolTimeoutSeconds` (outside the
consent hash: it grants nothing). Claude Code and Codex are served tools in
process and set none.

**The spawn tool requires `agent` of an agent that may not copy itself.** When
no grant names `self` or a wildcard, the tool's schema makes `agent` required
and the instructions say to always name one.

Considered: a wait limit carried on each call by the runner protocol (the
adapter knows its client best, but every sandbox runs a bundled runner, so the
host deriving it from the agent's definition changes no wire format); a fixed
45 second cap for every harness (it cannot follow a client that waits less);
answering a batch's calls concurrently (it would reorder the desktop's
stateful tools, and with one absolute limit per read the serial order already
answers in time); making spawn return before the child's workspace exists,
which is the right design for `own` workspaces and is left to the decision on
how code reaches a sandbox.

## Consequences

A rule over a family's results can compare commits. Coordinators whose agents
declare optional connections share their workspace. An ACP agent's long waits
return in time with the children still running, and it calls again. A spawn
that asks for a workspace of its own still provisions before it answers, so a
large repository can outlast the client's timeout there; the child is still
created and reports to its parent.
