# 0332: The commands an agent runs execute apart from the agent

- **Status:** Accepted (amends 0175, 0180, 0204, 0208, 0257, 0259, 0324)
- **Date:** 2026-11-18
- **Refines:** 0174, 0198, 0209, 0255, 0321, 0322, 0323

## Context

On a Work server a chat's harness runs in its sandbox (0180, 0198, 0255)
with what it uses: grant files (0175), the loopback model endpoint, the
Work tool endpoint (`submit_result`, 0323; subsessions, 0322), its state
and the `$WORK_PROGRAM` copy. The commands it ran (a pull request's tests,
`exec`, processes, terminals) shared its container and user, so the pull
request's code could read the grants, call Work's tools as the session and
rewrite what the agent trusts. ADR 0259 made the review advice; this closes
the gap in the platform.

## Decision

**An Environment can run commands apart:** `"commands": { "separate": true,
"connections": ["git"] }`. `connections` names the Environment's bindings
commands reach through the gateway, none by default, never a model. It
needs the machine capability `commands.separate`.

**One sandbox, two containers** (0204), one id, Allocation and lifecycle.
The **command container** keeps the id and runs everything that names no
side: setup (0208, 0257), `exec` (0324), terminals, processes, previews,
Work's Git on the checkout, the built-in agent's tools, and every shell
command and Git a harness runs. It has the volumes, Docker, the setup
network, the secrets and grants for `connections` alone. The **agent
container** (`<id>-agent`) holds the runner as root, the harness as uid
10001, the attempt's model grant only, the endpoints, the harness's state
and the program copy; no volume or runtime, never widened, run with
no-new-privileges. Root alone reads the session folder (grants, runner
state); the shim, an empty configuration home and pasted media are root's
and only readable to the harness, which writes the checkout, a temporary
folder and a cache home. The two share only the checkout volume, whose
shared group (gid 10001, setgid, umask 002, also at the end of the command
side's `/etc/profile`, which Alpine's login shells would reset) lets both
edit it. The command container gets `requirements.resources`; the agent
container `commands.agentResources` (1 CPU, 2 GiB by default); the
Allocation reserves the sum (0100). `side: "agent" | "commands"` on operations
defaults to `commands`.

**Harness shells go to the command container.** The machine serves a Unix
socket into the agent container alone. The provider writes a `bash` shim,
the harness's shell, and a `git` shim, which replaces every `git` in the
image, so Git named by any path runs apart whoever owns the checkout. The
shim starts in its own folder (on Node, or Bun with no configuration and
no .env files), so nothing planted in the checkout loads into it. It
forwards argv, the caller's folder, stdin, signals and an allowlist of
variables; the machine runs the command with `docker exec` in its own
process group, returning at most 64 MiB of output and the exit code. A
signal, a lost connection or the budget stops the group, as root, only
after reading its leader back by the command's own token. Claude Code's
working-directory files come back. Work-given stdio MCP servers start, for
either kind of harness, through `/bin/sh` in the harness's home with
`NODE_OPTIONS`, `NODE_PATH` and `BUN_OPTIONS` unset, never in the checkout.

- **Claude Code:** `CLAUDE_CODE_SHELL`, the `git` shim, no settings
  sources and only Work's MCP servers (native tests plant every project
  file, `.env` and `bunfig.toml` included: none loads). Its model is the
  runner's loopback on a key for that attempt. A Work-owned PreToolUse
  hook keeps file tools in the checkout; it cannot stop a link swapped
  between check and use, so the harness's own user is the boundary (a
  container test races one). A resumed thread's home, which the SDK makes
  as root, is handed to that user; links at the top of its config home are
  dropped before root reads it.
- **ACP agents** run apart only under a contract their definition states
  and Work cannot check: `"shell": true` and `"projectConfig": false`, with
  `"env"`. Work points `SHELL` at the shim and starts the launcher as the
  harness in its home. OpenCode does not meet it: 1.19.5 and 1.19.6 run
  plugins from the checkout's `.opencode/` and `opencode.json` whatever
  their settings (a native tripwire), so the review pack's OpenCode
  variant runs commands beside it, unprotected.
- **Codex** is refused: it picks its own shell. Machine sign-ins exist only
  for Codex, so none reaches a harness that runs apart.
- **The built-in agent** runs on the control plane; its tools already run
  on the command side. A sandbox admitted for a harness outside it (the
  built-in agent, a workflow) has no agent container and reserves no agent
  share: its command container is the sandbox, and a harness that runs in
  the sandbox is refused there.

`exec` copies `$WORK_PROGRAM` to both sides; the agent's copy is beyond the
commands' reach. Considered: wrapping each harness's shell in project code,
a daemon in the command container over a shared network, a shared
temporary folder, full limits for each container, and `nosymfollow` (the
volume driver ignores it under runc and gVisor).

## Consequences

The pull request's code reaches the checkout, the test services and the
listed connections, never the session's other authority. A pair costs two
containers, the agent's share and an exec per command. Breaking: Claude
Code there loads no repository or home settings, and the OpenCode review
pack drops `commands`. Microsandbox, local-process, Cloudflare and
privileged machines do not offer it. Follow-up: ACP client terminals.
What remains: hostile content can still talk the agent into misusing its
own authority; a link can reach what the harness's user holds (its cache,
transcripts and attempt-scoped loopback key); a harness that runs programs
from its cache could be led to plant one; an ACP agent is trusted on its
definition's word. On the command side, which is root, a command can make
decoy leaders carrying another command's kill token (read from
`/proc/<pid>/environ`) or rename its leader, and pid files sit in
`/tmp/.work-exec` (mode 1777): kills stay within the command side. Git's
other programs (`git-receive-pack`, `git-upload-pack`, `git-shell`,
`scalar`) remain in the agent container, but nothing there runs them.
The review stays advice (0259).
