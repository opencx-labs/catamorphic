# 0324: Workflows run commands in a chat's workspace, setup can be a workflow, and workspaces report their changes

- **Status:** Accepted (amends 0208, 0257)
- **Date:** 2026-11-17
- **Refines:** 0156, 0158, 0173, 0178, 0209, 0260, 0289, 0295

## Context

A workflow could reach a chat's workspace only by delivering
`workspace: { ref, update }` (ADR 0178), applied before the next turn. A pull
request reviewer needs more, and the opencx watcher built it with its own
driver: review procedure files (skills, prompts, scripts) copied from the
reviewing program over the pull request's own copies every time the
workspace is built, so a pull request cannot change how it is reviewed by
editing them; a push that lands during a review fetched beside the checkout
rather than resetting it under the agent; and prepared facts written as
files the agent reads. Work should provide the lifecycle points and one
command primitive, and leave the procedure to workflow code.

## Decision

**`exec`.** `host["catamorphic.sessions"].exec({ sessionId | key (+ audience),
command, cwd?, env?, in, timeoutSeconds?, idempotencyKey })` is a returned
transition like every session operation, answering `{ exitCode, stdout,
stderr, durationMs, timedOut }` with the last 16 000 characters of each
stream. `cwd` is relative to the checkout. The command runs with bash in the
chat's sandbox, with `$WORK_PROGRAM` naming a copy of the program the
calling run executes: the `.work/` folder at its deployed commit, outside the
checkout (`<workspace root>/.work-program`, `/workspace/.work-program` on
container and Cloudflare machines), copied once per commit per sandbox with
its write bits removed. Trusted files are copied from there, never from the
pull request.

- `in: "session"` runs as the agent's commands do: the chat's network, its
  grants and secrets. A chat with no running workspace gets one as a person
  opening its terminal does (ADR 0209); a command waiting for it or for a
  machine (ADR 0258) waits within its own timeout, then fails saying why. Its
  setup runs before the next turn, not before the command. A chat in a
  folder on a person's computer is refused.
- `in: "setup"` runs as the Environment's setup does: with `setup.network`
  (ADR 0257) widened for the command alone, with only the secrets
  `setup.secrets` names and no secrets file; without it, in the workspace
  with its secrets, as ADR 0208's setup. It is accepted only from the chat's own setup
  workflow while Work builds the workspace, when the sandbox holds the base
  checkout alone. Elsewhere it is refused: a used sandbox is never widened
  (ADR 0257), and a second sandbox cannot hand an installed dependency tree
  back. **Installing new dependencies while a turn runs is therefore not
  possible**: the reviewer reuses what setup installed, or moves the
  workspace (which runs setup again on the new base after the turn).

A command that outlives its boundary attempt (ADR 0295) parks the step: the
call records a host-call wait (`workflow_pauses` with the call), the run
waits and gives back its capacity as any wait does (ADR 0289), and a
follower job reads the process to its end and resumes the step with the
result, carried state included (ADR 0260). The execution is a session
action, so a retry with the same key returns the same execution's result
rather than running it twice. Canceling the run stops following; the
command runs on until its own timeout.

**Authority.** A project chat answers only the project's automations
holding `sessions:write`; a member's chat only that member's workflows, as a
person's terminal (ADR 0209). The chat's own setup workflow, a project
automation, reaches the chat it sets up while it does. Each execution is
recorded in the chat's log as an action, with the command and exit code.

**Setup can be a workflow.** An Environment's `setup` may name one:
`{ "workflow": "prepareReview", "command": "...", "timeoutMinutes": 30 }`,
with or instead of `command`. Work runs it at exactly the points it runs
setup (every new workspace, when the base moves, when the setup changes),
after the command, and the turn waits for it. Its input is `{ sessionId, key,
agentId, reason: "created" | "rebuilt" | "base-moved" | "changed",
workspace: { ref, commit } | null }`. A failure, a timeout or an
unenabled workflow is a failed setup: the agent is told with the error, and
it runs again before the next turn. It runs through its **project
enablement**, so its connections and declared permissions are the ones
consented there (ADRs 0068, 0076, 0158); a setup naming a workflow no one
enabled for the project fails saying so. No second consent path exists.
Work stamps the run with the chat and the workspace build it sets up
(`workflow_runs.setup_session_id`, `setup_build`), a fact only the setup path
writes and no caller's input or label reaches; `in: "setup"` needs that stamp
to name the build in progress, so a look-alike run or one for an earlier
build is refused. Nothing secret rides in correlation keys, which are labels. A
chat in a folder on a person's computer does not run it, and is told.

**Workspace events.** `session.workspace-changed` carries `change: "ready" |
"rebuilt" | "moved" | "released" | "lost"`, the workspace's ref and commit,
and a `reason`, with `payload.session.key` like every session event: ready
or rebuilt when a new workspace is made (its setup runs before the next
turn), moved after a base move, released when given back (idle, closed,
its connection ended), lost with its machine. Workflows react without
blocking the turn. A workspace that subsessions share (ADR 0322) is its
workspace session's: whichever session's turn makes or sets it up, the
setup workflow runs for that session, its run and record name it, and its
events do too; a shared subsession's close gives nothing back and reports
nothing.

Considered: a declarative workspace spec (Work would own the procedure),
widening a used sandbox for installs (ADR 0257's leak), polling a command
from the workflow (every poll an attempt), and a setup consent of its own.

## Consequences

The reviewer's procedure is project code: a setup workflow copies trusted
files from `$WORK_PROGRAM` and removes the pull request's copies; a push
workflow fetches the new head into `.versions/<sha>` and steers the chat.
This protects the review procedure from the pull request's diff, not from
the code the pull request runs: review images run as root with Docker, so
that code can change any file in the sandbox, `$WORK_PROGRAM` included. The
review stays advice; the publisher validates outside the sandbox (ADR 0259).
