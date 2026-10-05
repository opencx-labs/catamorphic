# 0208 — People reach their sandboxes: terminals and previews

- **Status:** Accepted
- **Date:** 2026-10-06
- **Refines:** 0098, 0174, 0206

## Context

On the Work server only agents could work in a chat's workspace. A developer
whose agents run on a remote machine could not open a shell beside them, run
a command themselves, or look at the app the agent started. The desktop's
editor and file browser work on the local copy (ADR 0098).

## Decision

**Terminals.** A person who may act on a chat (its owner, or someone with
`sessions:write` for a project chat) opens a terminal in its workspace:
`POST /projects/:id/agent/sessions/:sessionId/terminals`. It is a login
shell on a pseudo-terminal, started through the workspace's background
processes (ADR 0174) under `script` (an interactive shell on a pipe where
the sandbox has none), with the Environment's secrets loaded (ADR 0205).
Output is read by cursor with a wait, input and resizes are posted, and a
terminal ends with its workspace. A chat whose workspace was given back is
admitted again as its next turn would be, under the Allocation's
maintenance claim so no turn starts on it halfway. Postgres records who
opened each terminal: only they reach it, and their typing keeps the
workspace from being released as idle. The desktop opens one as an ordinary
terminal tab named for the chat.

**Previews.** `/projects/:id/agent/sessions/:sessionId/previews/:port/*`
forwards an HTTP request to that port inside a running workspace (a preview
never starts one), made by the sandbox's own runtime, so it works on every
backend and behind restricted egress. WebSocket upgrades are not forwarded.
The desktop opens a preview in a browser tab on a loopback origin of its
own, through its local proxy, which adds the member's credentials: a page's
root-relative URLs and cookies stay that preview's.

Harness sign-ins remain the harness's own login on the machine (ADR 0199):
a Work terminal passes through the control plane, so Work does not offer it
for signing in.

Considered: SSH into workers (needs an open port and per-person accounts on
each machine, and bypasses Work's access checks) and a separate streaming
transport (the sealed operation queue with local wakeups, ADR 0206, is fast
enough on one replica and correct on several).

## Consequences

A developer works beside their agents from the app. Terminal latency is one
round trip to the worker on a single replica and adds polling on several.
Hot reload over WebSocket does not reach previews; reload the page.
