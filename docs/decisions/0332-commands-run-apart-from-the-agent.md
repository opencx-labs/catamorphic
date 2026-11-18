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
  the built-in agent's tools, and every shell command and Git a harness
  runs. It gets the containers capability, the volumes, the setup network
  while setup runs, the Environment's secrets, and its own grants for
  `commands.connections` alone.
- The **agent container** (`<id>-agent`) holds the runner, the harness, its
  attempt's model grant (no other grant: its Git and HTTP run where commands
  run), the model and Work tool endpoints, the harness's state, sign-ins and
  the trusted `$WORK_PROGRAM` copy. It runs as uid 10001 with a home of its
  own, owning none of the checkout. No volume, no container runtime, never
  widened. People, models and workflows reach none of its processes.
- They share the checkout (`/workspace/project`, one Docker volume) and
  nothing else: each has its own `/workspace`, session folder, `/tmp`,
  network namespace and egress proxy. Commands never see the agent's
  loopback. The checkout belongs to the command side and passes a shared
  group (gid 10001) to everything made in it (setgid, umask 002 on both
  sides), so the agent edits it and Git beside the agent refuses it as a
  repository it does not own.
- **Limits:** the command container gets the Environment's
  `requirements.resources` (it runs the tests and services); the agent
  container its own share, `commands.agentResources`, 1 CPU and 2 GiB by
  default, fixed at admission. The Allocation reserves the sum, and a
  placement wait sizes machines for it, so admission (0100) stays truthful.

**Operations name their side.** `side: "agent" | "commands"` on commands,
uploads, downloads and process starts, carried by the worker queue; the
default is `commands`, so anything that forgets lands where the pull
request's code already is. A process id says which side it lives on. A
provider without the capability has one side.

**Harness shells go to the command container.** A provider with the
capability serves a Unix socket from the machine into the agent container
alone (`/run/work-commands/commands.sock`). The runner writes a `bash` shim,
the harness's shell, and a `git` shim, first on its `PATH`, beside its
state. They forward argv, cwd, stdin, signals and an allowlist of variables
(locale, terminal, time zone, CI, colors; the command side keeps its own
`PATH`, `HOME` and session files), and the machine runs the command in the
command container in its own process group (`docker exec`), streaming
output, at most 64 MiB, and the exit code back. A signal, a dropped
connection or the budget stops the whole group, signalled as the
container's own user. Claude Code's working-directory files come back,
small and regular only. The command container holds no socket, address or
file of the agent container, so it has no channel back.

- **Claude Code:** `CLAUDE_CODE_SHELL` (Bash, Monitor, background tasks),
  the `git` shim (it runs Git itself for its context), and only its home's
  settings: the checkout's `.claude` settings, hooks, MCP servers, skills and
  `CLAUDE.md` would run or steer the agent from the pull request. A
  Work-owned PreToolUse hook resolves each file tool's path to its real file
  and refuses one outside the checkout and the CLI's temporary folder
  (reads of the program copy excepted), so a link cannot lead it to the
  model grant or its settings. Docker's volume driver does not apply
  `nosymfollow` to a bind view under runc or gVisor (tested), so no mount
  option does this for every harness.
- **ACP agents** run apart only under a contract their definition states,
  which Work cannot check: `"shell": true` (every way the agent runs code
  goes through `$SHELL`) and `"projectConfig": false` (it loads no
  configuration, plugins, MCP servers, language servers, formatters or
  instructions from the checkout), with `"env"` naming what makes it so;
  Work sets `env` and points `SHELL` at the shim. Others are refused.
  OpenCode meets it with its project config, language servers,
  formatters, snapshots and Claude Code files off.
- **Codex:** refused. It takes the login shell from the password database
  and lets the model name any shell binary.
- **The built-in agent** runs on the control plane; its tools already run
  through the provider, on the command side. Separation keeps the grants
  not listed for commands out of its sandbox and gives it no trusted file
  copy, which it does not need: its instructions come from the control
  plane.

**Git and the program.** Work's Git on the checkout runs in the command
container: Git in the agent container on a repository the pull request
controls would run its configuration (hooks, `core.fsmonitor`, credential
helpers) there. Seeding needs no grant. Commands that fetch, `exec
in: "session"` included, use a Git binding listed in
`commands.connections`, so list only a read binding (`git:read`), one of
its own rather than the agent's. A fetch
helper in the agent container lost for the same reason. `exec` copies
`$WORK_PROGRAM` to both sides at the same path: the command's copy is as
trustworthy as the command container once the pull request's code ran; the
agent's is beyond its reach, and a workflow can name its path to the agent.

Considered: wrapping each harness's shell in project code (what the reviewer
did; every harness again), a daemon inside the command container reached
over a shared network (a route between the two), a shared temporary
folder (Claude Code keeps sockets there), and each container with the full
limits (twice the reservation's worth on the machine).

## Consequences

Code a pull request runs reaches the checkout, the test services and the
listed connections, never the session's other authority. A pair costs two
containers and the agent's share on top of the Environment's limits, and
one exec per command. Breaking: Claude Code in such an Environment no
longer loads the repository's `CLAUDE.md`, hooks or settings. Follow-up:
ACP client terminals (`terminal/create`), for agents that run commands
through their client rather than `$SHELL`.
Microsandbox, local-process and Cloudflare sandboxes do not offer it, nor
machines running privileged containers. What remains: the agent reads what
the pull request wrote, so hostile content can still talk it into misusing
its own authority; an ACP agent's file tools are its own, so a link can
still lead one to its model grant or its own configuration; an image whose
system Git configuration trusts every directory (`safe.directory=*`) undoes
the ownership refusal. The review stays advice (0259).
