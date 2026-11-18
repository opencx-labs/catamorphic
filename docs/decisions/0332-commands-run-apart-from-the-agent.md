# 0332: The commands an agent runs execute apart from the agent

- **Status:** Accepted (amends 0175, 0180, 0204, 0208, 0257, 0259, 0324)
- **Date:** 2026-11-18
- **Refines:** 0174, 0198, 0209, 0255, 0321, 0322, 0323

## Context

On a Work server a chat's harness runs in its sandbox (ADRs 0180, 0198,
0255) with everything it uses: the session's grant files (0175), the
loopback model endpoint (0255), the Work tool endpoint (`submit_result`,
0323; the subsession tools, 0322), its state and the `$WORK_PROGRAM` copy.
The commands it runs (a pull request's tests and install scripts, `exec`,
background processes, terminals) ran in the same container as the same
user, so code a pull request controls could read the grants, call Work's
tools as the session, spend the model budget and rewrite files the agent
trusts. A production pull request reviewer worked around this by wrapping
its harness's shell.

## Decision

**An Environment can run commands apart.** `"commands": { "separate": true,
"connections": ["github"] }` in `.work/project.json`. `connections` names
the Environment's own bindings commands may reach through the gateway,
none by default and never a model. Placement needs the machine capability
`commands.separate`, which the container backend (0204) offers where it
serves host sockets into sandboxes and runs no privileged containers.

**One sandbox, two containers,** with one id, one Allocation and one
lifecycle (start, stop, idle release, rebuild, destroy, shared
subsessions):

- The **command container** keeps the sandbox's id and runs everything Work
  does in a workspace unless it names the agent side: setup (0208, 0257),
  `exec` (0324), terminals (0209), background processes (0174), previews,
  Work's own Git on the checkout, the built-in agent's tools, and every
  shell command and Git a harness runs. It has the volumes, the container
  runtime, the setup network, the Environment's secrets, and grants for
  `commands.connections` alone.
- The **agent container** holds Work's runner (root), the harness (uid
  10001, owning none of the checkout), the attempt's model grant and no
  other, the model and Work tool endpoints, the harness's state and
  sign-ins, and the trusted `$WORK_PROGRAM` copy. No volume, no container
  runtime, never widened; people, models and workflows reach none of its
  processes.
- They share only the checkout (`/workspace/project`), which belongs to the
  command side and passes gid 10001 to everything made in it. Every `git`
  in the agent container's image is replaced by Work's shim.
- The command container gets the Environment's limits, the agent container
  `commands.agentResources` (1 CPU and 2 GiB by default). The Allocation
  reserves the sum, so admission (0100) stays truthful.

**Operations name their side:** `side: "agent" | "commands"` on commands,
uploads, downloads and process starts, `commands` by default, so anything
that forgets lands where the pull request's code already is. A provider
without the capability has one side.

**Harness shells reach the command container through one socket** the
machine serves into the agent container alone. Work's `bash` and `git`
shims forward argv, cwd, stdin, signals and an allowlist of variables; the
machine runs the command in the command container in its own process
group and streams its output (at most 64 MiB) and exit code back. A
signal, a dropped connection or the budget stops the group. The command
container has no channel back.

**Each harness:**

- **Claude Code** gets the shims as its shell and Git, no settings sources
  and only Work's MCP servers (the checkout's `CLAUDE.md`, `.claude`
  settings, hooks, MCP servers and skills would run or steer it), its
  model through the runner's loopback on a key for that attempt alone, and
  a PreToolUse hook that keeps its file tools in the checkout; its own
  user holds where the hook cannot (a swapped link).
- **ACP agents** run apart only under a contract their definition states
  and Work cannot check: `"shell": true` and `"projectConfig": false`, with
  the `"env"` that makes it so. OpenCode cannot state it truthfully (it
  runs the checkout's plugins whatever its settings say) and is refused.
- **Codex** is refused: it picks its own shell.
- **The built-in agent** is unchanged: its tools already run through the
  provider, on the command side.

**Git and the program.** Work's Git on the checkout runs in the command
container: Git beside the agent on a repository the pull request controls
would run its configuration there. Commands that fetch use a Git binding in
`commands.connections`; list a read binding of their own. `exec` copies
`$WORK_PROGRAM` to both sides; only the agent's copy stays trustworthy.

Considered: wrapping each harness's shell in project code (every harness
again), a daemon in the command container over a shared network (a route
between the two), a shared temporary folder (Claude Code keeps sockets
there), and full limits for each container (twice the reservation).

## Consequences

Code a pull request runs reaches the checkout, its test services and the
listed connections, never the session's other authority. A pair costs two
containers, the agent's share on top of the Environment's limits, and one
exec per command. Microsandbox, local-process, Cloudflare and machines
running privileged containers do not offer it. Breaking: Claude Code there
loads no settings files; ACP agents need the contract; OpenCode and Codex
are refused. What remains (detailed in the server guide's harness section):
the agent still reads what the pull request wrote and can be talked into
misusing its own authority; a link can lead a harness's file tools to what
its own user holds; an ACP agent is trusted on its definition's word.
Follow-up: ACP client terminals (`terminal/create`). The review stays
advice (0259).
