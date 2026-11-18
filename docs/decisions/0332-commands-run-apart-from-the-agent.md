# 0332: The commands an agent runs execute apart from the agent

- **Status:** Accepted (amends 0175, 0180, 0204, 0208, 0257, 0259, 0324)
- **Date:** 2026-11-18
- **Refines:** 0174, 0198, 0209, 0255, 0321, 0322, 0323

## Context

On a Work server a chat's harness runs in the chat's sandbox (ADRs 0180,
0198, 0255) with everything it uses: the session's grant files (0175), the
loopback model endpoint (0255), the Work tool endpoint the harness calls
(`submit_result`, 0323; the subsession tools, 0322), its saved state, and
the `$WORK_PROGRAM` copy. The commands it runs (a pull request's tests and
install scripts, `exec` from workflows, background processes, terminals)
ran in the same container as the same user. Code a pull request controls
could read the grants, call Work's tools as the session, spend the model
budget and rewrite files the agent trusts. A production pull request
reviewer worked around this by wrapping its harness's shell. ADR 0259 made
the review advice; this closes the integrity gap in the platform.

## Decision

**An Environment can run commands apart.** `"commands": { "separate": true,
"connections": ["github"] }` in `.work/project.json`. `connections` names
the Environment's own bindings that commands may reach through the gateway,
none by default; a binding with the `model` capability is refused. Placement
needs the machine capability `commands.separate`.

**One sandbox, two containers.** The container backend (0204) makes the
sandbox a pair with one id, one Allocation and one lifecycle: start, stop,
idle release, rebuild, destroy and shared subsessions (0322) act on both.

- The **command container** keeps the sandbox's id. Everything Work does in
  a workspace runs there unless it names the agent side: setup (0208, 0257),
  `exec` in either mode (0324), terminals (0209), background processes
  (0174), previews, Work's own Git on the checkout (seed, sync, checkpoint),
  the built-in agent's tools, and every shell command a harness runs. It
  gets the containers capability, the volumes, the setup network while setup
  runs, the Environment's secrets, and grants only for `commands.connections`.
- The **agent container** (`<id>-agent`) holds the runner, the harness, every
  grant, the model and Work tool endpoints, the harness's state, sign-ins and
  the trusted `$WORK_PROGRAM` copy. No volume, no container runtime, never
  widened.
- They share the checkout (`/workspace/project`, one Docker volume) and
  nothing else: each has its own `/workspace`, session folder, `/tmp`,
  network namespace and egress proxy. Commands never see the agent's
  loopback.

**Operations name their side.** `side: "agent" | "commands"` on commands,
uploads, downloads and process starts, carried by the worker queue; the
default is `commands`, so anything that forgets lands where the pull
request's code already is. A process id says which side it lives on. A
provider without the capability has one side.

**Harness shells go to the command container.** A provider with the
capability serves a Unix socket from the machine into the agent container
alone (`/run/work-commands/commands.sock`). The runner writes a `bash` shim
beside its state; it forwards argv, cwd, stdin, signals and the
environment less Work's variables and model keys, and the machine runs the
command in the command container in its own process group (`docker exec`),
streaming output and the exit code back. A signal or a dropped connection
stops the whole group. Files a command writes directly in a return folder
the shim names (Claude Code's working-directory file) come back, small and
regular only. The command container holds no socket, address or file of
the agent container, so it has no channel back.

- **Claude Code:** `CLAUDE_CODE_SHELL` (Bash, Monitor, background tasks),
  and only its home's settings: the checkout's `.claude` settings, hooks,
  MCP servers, skills and `CLAUDE.md` would run or steer the agent from the
  pull request, so they are not loaded.
- **ACP agents:** `SHELL`, for a definition with `"acp": { "shell": true }`
  (OpenCode runs its shell tool with `$SHELL`). Others are refused.
- **Codex:** refused. It takes the login shell from the password database
  and lets the model name any shell binary.
- **The built-in agent** runs on the control plane; its tools already run
  through the provider.

**Git and the program.** Work's Git on the checkout runs in the command
container: Git in the agent container on a repository the pull request
controls would run its configuration (hooks, `core.fsmonitor`, credential
helpers) there. Seeding needs no grant. Commands that fetch, `exec
in: "session"` included, use a Git binding listed in
`commands.connections`, so list only a read binding (`git:read`). A fetch
helper in the agent container lost for the same reason. `exec` copies
`$WORK_PROGRAM` to both sides at the same path: the command's copy is as
trustworthy as the command container once the pull request's code ran; the
agent's is beyond its reach, and a workflow can name its path to the agent.

Considered: wrapping each harness's shell in project code (what the reviewer
did; every harness again), a daemon inside the command container reached
over a shared network (a route between the two), and a shared temporary
folder (Claude Code keeps sockets there).

## Consequences

Code a pull request runs reaches the checkout, the test services and the
listed connections, never the session's other authority. A pair costs two
containers, each with the Environment's limits, and one exec per command.
Microsandbox, local-process and Cloudflare sandboxes do not offer it, nor
machines running privileged containers. What remains: the agent reads what
the pull request wrote, links included, so hostile content can still talk
the agent into misusing its own authority; the review stays advice (0259).
