/** Shared authoring guidance offered to every harness through host skill discovery. */
export const SESSION_WORKFLOWS_SKILL = `---
name: session-workflows
description: Author Catamorphic workflows for timed wakeups, recurring checks, session lifecycle events, directory events (people joining or leaving), and attributed session actions. Use for ephemeral session monitors, durable agent automations, and onboarding or offboarding automations.
---

# Session workflows

Use workflow-lifecycle to choose source ownership and activation, writing-workflows
for TypeScript shape, and durable-workflows when designing transitions. Temporary
and permanent enablements use the same defineWorkflow, trigger, and host calls.
Discover this host's actual capabilities and schemas before authoring.

## Choose the action

| Request | Delivery | Lifetime |
| --- | --- | --- |
| Remind the user | deliver with mode: "message_only", attention: "required" | One-shot schedule owned by the session, no default expiry |
| Wake an agent to do work | deliver with mode: "queue" | One-shot or conditional monitor; stop when its purpose is complete |
| Monitor events without noise | Inspect the event/state, then deliver only a meaningful change | Session watcher or explicitly enabled reusable workflow |
| Have an agent prepare a recurring result in a stable chat | deliver with a stable key (e.g. "daily") | Member or project enablement; the key reuses the same chat |
| Have an agent handle something for everyone in the project (a PR review, an inbound request) | deliver with the event's key; the project shares one chat per key | Project enablement |

Neither saving source nor deploying alone turns a trigger on. A workflow return
ends that run, not its recurring activation.

## Clock and event selection

schedule config is exactly one of { at: "2026-09-14T12:00:00Z" } or
{ cron: "*/5 * * * *", timezone: "Asia/Amman" }. Resolve relative times from the
current clock once when authoring. at fires once, including after an offline
host returns, provided the activation has not expired. Cron coalesces missed
occurrences. Input is { activationId, scheduledFor, firedAt }. Omit expiresInSeconds
for reminders: they have no default expiry and survive months offline. An explicit
expiry is a separate user-requested deadline, never a substitute for scheduled time.
Local session watchers stay on the local host and use its Environment. They cannot
run while that host is stopped; overdue one-shots run once when it returns. Closing
a chat leaves reminders active. Archiving cancels all its watchers and those of
its subsessions, including paused ones; restoring the chat does not restart them.
When confirming a reminder, tell the user its resolved date and time, that it
arrives late if this computer is off (or name the machine that runs it when it is
not this one), and that archiving the chat cancels it. Say it in plain words.

Session event kinds: session.created, session.message-received, session.message-sent,
session.turn-changed, session.state-changed, session.work-changed,
session.authority-changed, session.result-recorded, session.workspace-changed,
session.turn-stalled, session.request-opened, and session.workspace-setup (the
one event a turn waits for, see "Setting a workspace up"). Config may select sessionId, agentId, statuses,
workStatus, and (for results) names. Omitting sessionId observes authorized
matching sessions in the project. Example: trigger("session.turn-changed", { sessionId: "actual-id",
statuses: ["completed", "failed"] }). Never guess an id. Keyed chats carry their
key in payload.session.key (null otherwise), so where selects a family of chats
without starting runs for the rest: where: { payload: { session: { key: {
$prefix: "pr-" } } } }.

A watcher may bind the project's own trigger kinds too, such as the GitHub
library in writing-workflows. A host without a public webhook URL (the desktop)
can observe for it instead: pass the host's event source to create_watcher
(eventSource: "github"). The host polls the repository with your GitHub
connection from the watcher's start and records events shaped like the webhook's
deliveries, with payload.origin { type: "host" } in place of a signature, so the
same trigger kinds and where filters match on every host. A server without a
public URL feeds those kinds for the whole project instead with a workflow that
polls and records them (writing-workflows, "Recording events"; the
github-polling pack).

Events are normalized Project Events. input.payload.session is the snapshot at
the transition; input.payload.detail contains the message/turn/visibility change.
input.payload.actor identifies the initiator. message-received means inbound context;
message-sent means a settled assistant segment, never a token update. A workflow can use ordinary if
statements over those values. Read current state with the read host transition
when a decision needs fresh state; optionally pass expectedStateRevision with
the subsequent mutation. Event state and current state may legitimately differ. A remote mirror may lag
its authority host; expectedStateRevision is checked where the mutation is applied.

A completed turn is not completed work. Turns can end while waiting for another
session or queued work. Use session_complete to explicitly declare work finished,
and session_reopen for new work. Observe session.work-changed with
{ workStatus: "completed" } when the task, rather than one turn, matters.

## Host calls and authoring shape

context.host["catamorphic.sessions"] provides the session operations every
surface shares, typed: start, send, wait, read, answer, list, interrupt,
close, fork, spawn, archive, unarchive, restart, complete, reopen,
stopWatcher, setMetadata and changedPaths, beside deliver, exec and stop. Each
answers with the chat's state (state is working, needs_input, idle, failed or
closed). read takes include to add the transcript, every result, usage, a
turn's attempts, or metadata. changedPaths({ sessionId | key, from, to })
answers { paths, truncated, complete } instead: the paths that differ between
two commits of the chat. Every
host call is a boundary transition: RETURN it. Consume its result as the next
boundary's input
(pass { state } as a second argument to keep data across it; the next boundary
then receives { result, state }, see durable-workflows).
Do not await it, put it inside a use-step helper, or invoke a second host call
in the same boundary. Put ordinary network/file IO in use-step helpers with
one destructured object parameter and JSDoc display names.

### Agent wakeup

A self-wake uses this shape. Replace the example timestamp from the current clock,
and use the actual session id and requested work:

\`\`\`typescript
import { defineWorkflow, trigger, type BoundaryContext } from "@catamorphic/workflow";
/** @displayname Follow up */
export const followUp = defineWorkflow(({ defineBoundary }) => ({
  triggers: [trigger("schedule", { at: "2026-09-14T12:00:00Z" })],
  steps: [
    /** @displayname Wake the session */
    defineBoundary({
      run: (context: BoundaryContext<{ activationId: string; scheduledFor: string; firedAt: string }>) =>
        context.host["catamorphic.sessions"].deliver({
          sessionId: "REPLACE_WITH_CURRENT_SESSION_ID",
          content: "Continue the requested follow-up. Inspect current state first.",
          mode: "queue",
          idempotencyKey: context.input.activationId + ":" + context.input.scheduledFor,
        }),
    }),
    /** @displayname Stop the temporary activation */
    defineBoundary({
      run: (context: BoundaryContext<unknown>) =>
        context.host["catamorphic.sessions"].stop({ idempotencyKey: "stop" }),
    }),
  ],
}));
\`\`\`

For a monitor, replace the first boundary with a bounded check and branch on a
meaningful change. Finish silently when nothing needs action. Persist a checkpoint
in ordinary durable project/app data if the external source has no stable event
identity. A failed HTTP request is not evidence that the monitored job failed.
Use timeouts and limited retries. Return enough state between boundaries to keep
the target session id, original event id, and decision evidence available.

### Completion monitor

A reusable completion monitor can use broad routing plus an ordinary predicate.
Save this in project source, replace the target id, and explicitly enable it:

\`\`\`typescript
import { defineWorkflow, trigger, type BoundaryContext } from "@catamorphic/workflow";
type Completion = { id: string; payload: { sessionId: string; session: { parentSessionId: string | null; workStatus: "open" | "completed" } } };
/** @displayname Watch child completion */
export const childCompletion = defineWorkflow(({ defineBoundary }) => ({
  triggers: [trigger("session.work-changed", { workStatus: "completed" })],
  steps: [
    /** @displayname Notify the parent */
    defineBoundary({
      run: (context: BoundaryContext<Completion>) => {
        const event = context.input;
        const parentId = "REPLACE_WITH_PARENT_SESSION_ID";
        if (event.payload.session.parentSessionId !== parentId || event.payload.session.workStatus !== "completed") {
          return { matched: false };
        }
        return context.host["catamorphic.sessions"].deliver({
          sessionId: parentId,
          mode: "message_only",
          attention: "required",
          content: "A child session finished its work. Inspect its result before continuing.",
          idempotencyKey: "child-finished:" + event.id,
        });
      },
    }),
  ],
}));
\`\`\`

This monitor intentionally remains enabled for later children. For one child,
create a temporary watcher and filter its exact sessionId in trigger config. If
predicates can reject an event, branch the stop boundary too: a quiet return from
one boundary does not skip the next boundary. Stop only after a matching action. The stop operation belongs to temporary activations.
Use read in a preceding boundary if current state must supersede the event
snapshot. deliver with message_only and attention: "required" requests user attention without running a model
(the agent reads it with its next turn);
use deliver with queue when the parent agent should continue automatically.

### User reminder

For a reminder that needs no agent work, deliver the message directly and stop the
temporary activation. Keep scheduledFor in the content so late delivery is clear.
Replace the example date, target, and text before creating the watcher.

\`\`\`typescript
import { type BoundaryContext, defineWorkflow, trigger } from "@catamorphic/workflow";
type Schedule = { activationId: string; scheduledFor: string; firedAt: string };

/** @displayname Send reminder */
export const remindUser = defineWorkflow(({ defineBoundary }) => ({
  triggers: [trigger("schedule", { at: "2026-09-21T09:00:00+03:00" })],
  steps: [
    /** @displayname Deliver reminder */
    defineBoundary({
      run: ({ input, host }: BoundaryContext<Schedule>) =>
        host["catamorphic.sessions"].deliver({
          sessionId: "REPLACE_WITH_CURRENT_SESSION_ID",
          content: "Reminder: review the proposal. Scheduled for " + input.scheduledFor,
          mode: "message_only",
          attention: "required",
          idempotencyKey: input.activationId + ":" + input.scheduledFor,
        }),
    }),
    /** @displayname Stop reminder */
    defineBoundary({
      run: ({ host }: BoundaryContext<unknown>) =>
        host["catamorphic.sessions"].stop({ idempotencyKey: "stop" }),
    }),
  ],
}));
\`\`\`

### A chat per pull request

A project automation that reviews each pull request in its own chat, shared with
everyone in the project. It binds \`github.pull_request\` from the GitHub trigger
library in \`writing-workflows\` (\`.work/triggers/github.ts\`), and its \`where\`
lets only opened and updated, non-draft pull requests start a run. Enable it for
the project; the key reuses the chat when the same pull request changes again.
\`workspace\` starts the chat's checkout at the pull request's head, fetched from
the project's remote by the host; each later push moves the same chat to the new
head (the agent is told the old and new heads and what changed), and the chat's
\`workspace\` records the exact commit it reviewed.
Keys belong to the project, so a second automation closes the same chat when
the pull request merges or closes: its workspace, branches, and grants are
released, the transcript stays readable, and a reopened pull request starts a
fresh chat.

\`\`\`typescript
import { type BoundaryContext, defineWorkflow, type TriggerPayload, trigger } from "@catamorphic/workflow";

/** @displayname Review pull requests */
export const reviewPullRequests = defineWorkflow(({ defineBoundary }) => ({
  triggers: [
    trigger("github.pull_request", {
      where: { payload: { body: { action: ["opened", "synchronize", "reopened"], pull_request: { draft: false } } } },
    }),
  ],
  steps: [
    /** @displayname Ask for a review */
    defineBoundary({
      run: ({ input, host }: BoundaryContext<TriggerPayload<"github.pull_request">>) => {
        const event = input.payload.body;
        return host["catamorphic.sessions"].deliver({
          key: "pr-" + event.repository.full_name + "-" + event.number,
          workspace: { ref: "refs/pull/" + event.number + "/head", update: "reset" },
          title: "Review: " + event.pull_request.title,
          content: "Review the changes in " + event.pull_request.html_url + " and summarize risks.",
          notification: { title: "Review ready", body: event.pull_request.title },
        });
      },
    }),
  ],
}));

/** @displayname Close pull request chats */
export const closePullRequestChats = defineWorkflow(({ defineBoundary }) => ({
  triggers: [trigger("github.pull_request", { where: { payload: { body: { action: "closed" } } } })],
  steps: [
    /** @displayname Close the review chat */
    defineBoundary({
      run: ({ input, host }: BoundaryContext<TriggerPayload<"github.pull_request">>) => {
        const event = input.payload.body;
        const key = "pr-" + event.repository.full_name + "-" + event.number;
        return host["catamorphic.sessions"].close({ key, idempotencyKey: "closed:" + key });
      },
    }),
  ],
}));
\`\`\`

### Commands in a chat's workspace

exec runs a shell command in a chat's workspace and answers { exitCode, stdout,
stderr, durationMs, timedOut } (the last 16 000 characters of each stream, the
chat's secret values masked), and outOfDisk when it failed while its machine
is short of disk or its output says no space was left. Name
the chat by sessionId or key, pass command, in, idempotencyKey, and optionally
cwd (beneath the checkout), env and timeoutSeconds (default 600, at most 14 400).
in: "session" runs as the agent's commands do: the chat's network, grants and
secrets, from its checkout, starting its workspace when it has none. in: "setup"
runs as the Environment's setup does (on the setup's own network, with only the
secrets setup.secrets names, no grants) and only from a run the chat's setup
event started (below) while Work sets the workspace up, ending by the setup's
own time; anywhere else it is refused. When the setup ends, whatever it started
there is stopped. Installing new dependencies
while a turn runs is not possible: a sandbox in use never gets the setup's
network. Reuse what setup installed, or move the workspace so setup is due again.

$WORK_PROGRAM names a copy of this run's .work/ folder at its deployed commit,
outside the checkout, write bits removed: copy trusted files (review skills,
prompts, scripts) from there, never from the change under review. cp keeps the
read-only mode, so make copies writable (chmod -R u+w), and in a sandbox that
was kept an earlier setup's copy is read-only too: cp -f, or removing it first,
replaces it. A command longer than
the boundary's attempt parks the run until it ends, holding none of its
capacity; a retry with the same idempotencyKey answers with the same execution.
A project chat answers project automations holding sessions:write, a member's
chat only that member's workflows, and a run the chat's setup event started
reaches that chat; each execution is written in the chat's log.
Commands see the chat's checkout as the agent left it, and code the chat runs
can change any file in its sandbox: this keeps a change from rewriting its own
review procedure in its diff, not a hostile change from tampering at run time.
Where the Environment runs commands apart ("commands": { "separate": true },
ADR 0332), exec runs in the command container with the agent's commands: it
holds grants only for the bindings commands.connections lists (list a read Git
binding for git fetch), never the agent's own. $WORK_PROGRAM is then copied
beside the agent too, at the same path, where no command reaches it: print it
from exec and tell the agent to read its procedure there, since copies in the
checkout are only as trustworthy as the code that runs after them.

session.workspace-changed reports detail.change: "ready" (its first workspace),
"rebuilt" (made again), "moved" (a new base), "released" (given back) or "lost"
(gone with its machine), with detail.reason and detail.workspace. statuses in
trigger config selects changes: trigger("session.workspace-changed", { statuses:
["moved"] }). Reacting never holds the turn.

### Setting a workspace up

A project workflow sets workspaces up by binding session.workspace-setup in its
own source: triggers: [trigger("session.workspace-setup", {})], with where to
narrow it (payload.session.key, payload.detail.environment), enabled as a
project automation. No configuration names it: setup.workflow was removed from
.work/project.json, and a manifest that still has it is invalid and says to
bind the trigger. An Environment's setup takes command, timeoutMinutes, network
and secrets, and may have no command. Work records the event where setup is due
(every new workspace, when the base moves, when the command changes), and the
turn waits for every run the event starts for a project automation, within the
Environment's setup.timeoutMinutes (30 by default). Several listening workflows
all run, and the turn goes on when all have ended. A run that fails or is
canceled, a listener that could not start, or the deadline (runs still going
are canceled) is a failed setup: the agent is told, the turn goes on, and setup
is asked again before the next turn. A member's own automation may bind the
event too: the turn never waits for it, and it may not run commands in:
"setup". For a member's own chat a project automation hears the event only
when it declares sessions:write, as for every session event; the project's own
chats (a reviewer's keyed chats) need nothing extra. A chat that works in a
folder on a person's computer records no setup event. A workspace subsessions
share is their parent's: its setup event and its other events name the parent,
whichever chat's turn made it.

Input is the session event envelope: input.id (the event's id, good for
idempotency keys), input.payload.sessionId, input.payload.session.key, and
input.payload.detail { reason: "created" | "rebuilt" | "base-moved" |
"changed", environment (the Environment's name), workspace: { ref, commit },
previous: { commit } | null (the base this sandbox last set up on), sandbox:
"new" | "kept" }. statuses in trigger config selects reasons:
trigger("session.workspace-setup", { statuses: ["base-moved"] }). A workflow
decides by the operations it calls during its run, never through what it
returns.

sandbox: "new" means this sandbox has not set up before (Work made it for this
turn, or its earlier setup failed; previous is null): Work ran the
Environment's setup.command first (on its own network when declared), then
recorded the event. exec with in: "setup" from a run the event started runs
as setup does: on the setup's network (the sandbox is widened for that
command), with only the secrets setup.secrets names, no grants.

sandbox: "kept" means the chat already used and set up this sandbox, and setup
is due because the base moved or the command changed. Work replaced nothing and
did not run setup.command again. It moved the checkout to the new base in place:
Git sends what it lacks, and ignored files such as installed packages stay.
A sandbox is not kept while another session's turn runs in the workspace: it
is replaced as before. What happens next is the workflow's to say:

- A run calls exec with in: "setup", and the Environment's setup has a network
  of its own: Work makes a new sandbox at that point (same Allocation, base
  checked out, setup.command run in it on that network), then runs the command
  there. Later in: "setup" calls of the same setup use it. The chat's saved
  work and credentials arrive after, as before. What a run did in the kept
  sandbox before asking is lost with that sandbox, so network work goes first.
- No run asks for the setup's network: the sandbox, its checkout and
  everything setup installed stay, and setup is recorded done for the new base.
- exec with in: "session" runs in whichever sandbox is current and never asks
  for a new one. Without a setup network, in: "setup" runs in place in the
  kept sandbox.

changedPaths({ sessionId | key, from, to }) answers { paths, truncated,
complete }: the paths that differ between two commits of the chat, read from
the session's copy on the control plane, so nothing runs in the workspace. At
most 2000 paths come back (truncated says more differ). complete: false, with
no paths, means the copy does not hold one of the commits: treat it as
everything may have changed. It needs what other reads of the chat need. A
setup workflow compares previous.commit with workspace.commit to see whether a
lockfile changed.

Keeping a sandbox means a later revision is reviewed where an earlier revision
already ran code. That is the workflow's choice, and there is no other switch.
This changed what a push costs. Where a workflow listens, a push no longer
reruns setup.command by itself in a sandbox that already set up: the workflow
asks for the setup's network to have it run again. Where nobody listens,
nothing changed: every push replaces the sandbox of an Environment whose setup
has a network and reruns the command.

Below, setup.command is the install ("pnpm install --frozen-lockfile") and the
workflow's command repeats it, so the example is right with or without a setup
network: with one, Work has run setup.command in the new sandbox and the
command finds nothing left to do; without one, it installs in place. Where the
setup has a network, a command that does nothing (true) is enough to ask.

\`\`\`typescript
import { type BoundaryContext, type Carried, defineWorkflow, type SessionChangedPaths, type SessionExecResult, type TriggerPayload, trigger } from "@catamorphic/workflow";

/** What a setup carries from step to step. */
type Setup = { event: string; sessionId: string; install: boolean };

/** @displayname Prepare a review workspace */
export const prepareReview = defineWorkflow(({ defineBoundary }) => ({
  triggers: [
    trigger("session.workspace-setup", {
      where: { payload: { session: { key: { $prefix: "pr-" } } } },
    }),
  ],
  steps: [
    /** @displayname See what changed */
    defineBoundary({
      run: ({ input, host }: BoundaryContext<TriggerPayload<"session.workspace-setup">>) => {
        const { sessionId, detail } = input.payload;
        const setup: Setup = { event: input.id, sessionId, install: false };
        // Not set up here before: Work already ran setup.command.
        if (detail.sandbox === "new" || !detail.previous) return { result: null, state: setup };
        return host["catamorphic.sessions"].changedPaths(
          { sessionId, from: detail.previous.commit, to: detail.workspace.commit },
          // The command itself changed: install whatever the paths say.
          { state: { ...setup, install: detail.reason === "changed" } },
        );
      },
    }),
    /** @displayname Install when a lockfile changed */
    defineBoundary({
      run: ({ input, host }: BoundaryContext<Carried<SessionChangedPaths | null, Setup>>) => {
        const changed = input.result;
        // Not complete, or too much to list: everything may have changed.
        const install =
          input.state.install ||
          (changed !== null &&
            (!changed.complete || changed.truncated || changed.paths.some((path) => path.endsWith("pnpm-lock.yaml"))));
        const setup: Setup = { ...input.state, install };
        if (!install) return { result: null, state: setup };
        // On the setup's network, so first: in a kept sandbox Work makes a new
        // one for it, and what ran before would be lost with the old.
        return host["catamorphic.sessions"].exec(
          { sessionId: setup.sessionId, in: "setup", command: "pnpm install --frozen-lockfile", idempotencyKey: "install:" + setup.event },
          { state: setup },
        );
      },
    }),
    /** @displayname Put the trusted procedure in place */
    defineBoundary({
      run: ({ input, host }: BoundaryContext<Carried<SessionExecResult | null, Setup>>) => {
        if (input.result && input.result.exitCode !== 0)
          throw new Error("The install failed: " + input.result.stderr.slice(-500));
        // In the session, last: it never asks for a new sandbox. cp -f, since an
        // earlier setup's copy in a kept sandbox is read-only.
        return host["catamorphic.sessions"].exec({
          sessionId: input.state.sessionId,
          in: "session",
          command: 'mkdir -p .work/skills/review && cp -f "$WORK_PROGRAM/skills/review/SKILL.md" .work/skills/review/SKILL.md',
          idempotencyKey: "trusted:" + input.state.event,
        });
      },
    }),
  ],
}));
\`\`\`

### Turns that stop making progress

read (and list) answer queued, the ids of the chat's turns waiting to run,
oldest first, and turn: the turn working now, or null, with its
attempt { id, ordinal, reason, startedAt }, attempts and restarts so far,
progressAt (when its attempt last made progress: anything from its harness but
a log line, or a model call), stalledAt, stallMinutes, and running { tools,
commands }: the tool calls and commands it reported still running, each with
since. An agent definition's "stall": { "minutes": 20 } (1 to 1440; absent,
never) makes Work record a running turn silent that long once, as
session.turn-stalled with detail { turnId, attemptId, attempt, attempts,
restarts, progressAt, stalledAt, stallMinutes, activity }. Progress clears it;
a later silence emits again. A turn waiting on a person never stalls, nor does
one whose subsessions, at any depth, made progress within its threshold (a
coordinator waits while its subagents work); a subsession stalls on its own
threshold. Work does
nothing on its own: deciding a silence is a hang is the workflow's.

restart({ sessionId | key, turnId, attemptId, reason, onlyIfStalled?,
idempotencyKey }) ends that attempt without asking its harness (its runner is
asked to stop, its process group killed after ten seconds, its model grant
revoked, its open tool calls closed) and runs the same turn again on a new
attempt, told it was restarted and why and to check what it already did. It
needs the authority interrupt needs. It ends only the attempt named, while it
is the turn's running attempt (and, with onlyIfStalled, while it is stalled,
checked again when Work acts): otherwise it answers { restarted: false,
refused: "not_running" | "not_current" | "not_stalled", message }, which is
nothing to do, never an error. A restart answers { restarted: true, turnId,
attemptId, attempt, attempts, restarts }; key it by the stalled attempt so a
retry restarts once, and bound it with restarts. interrupt takes turnId too:
it stops that turn only, and answers { interrupted: false } when it no longer
works. read({ sessionId | key, turnId, include: ["attempts"] }) reads a turn's attempts: status,
error, progressAt, and diagnostics { runner, harness }, the last 16 000
characters of the runner's and the harness's own output, masked, in whole
lines, kept for attempts that did not complete. Each attempt also has phases,
how long each part of its preparation took: [{ phase, startedAt, endedAt }],
oldest first, endedAt null while one runs, so a turn stuck preparing shows
where. The phases, each where it applied: machine.wait (the chat waited for a
machine), workspace.wait (another chat's turn was making or setting up the
workspace they share), sandbox.create (its image pulled or built too),
sandbox.start, workspace.checkout (the base commit), workspace.restore (the
chat's saved work), setup.environment, setup.workflow (the time the turn
waited for its setup event's runs), setup.personal,
harness.start and harness.first-output (until the agent's first item). Time
between phases is Work's own preparation. Keep the diagnostics as the evidence,
not exec output: code the chat runs can forge what a command prints, and
commands may run apart from the agent, seeing neither its processes nor its
logs. Read the chat again before acting. To keep the evidence in the project
store, declare its folder in documents, such as
[{ path: "store/stalls/", access: "write" }]: a workflow, a watcher's
included, reaches no store path it does not declare, whoever runs it. The pull-request-reviews pack's
restartStalledReviews is a complete recipe: read, read with
include: ["attempts"], a store document under its declared folder, read
again, then restart, or interrupt past its bound.

\`\`\`typescript
import {
  type BoundaryContext,
  defineWorkflow,
  type TriggerPayload,
  trigger,
} from "@catamorphic/workflow";

/** @displayname Restart stalled chats */
export const restartStalled = defineWorkflow(({ defineBoundary }) => ({
  triggers: [
    trigger("session.turn-stalled", {
      where: { payload: { session: { key: { $prefix: "pr-" } } } },
    }),
  ],
  permissions: ["sessions:write"],
  steps: [
    /** @displayname Restart the turn, twice at most */
    defineBoundary({
      run: ({ input, host }: BoundaryContext<TriggerPayload<"session.turn-stalled">>) => {
        const { sessionId, detail } = input.payload;
        // This turn only: a newer one may be running by now.
        if (Number(detail.restarts) >= 2)
          return host["catamorphic.sessions"].interrupt({
            sessionId,
            turnId: String(detail.turnId),
            idempotencyKey: "stall-stop:" + String(detail.turnId),
          });
        // This attempt only, while it is still stalled.
        return host["catamorphic.sessions"].restart({
          sessionId,
          turnId: String(detail.turnId),
          attemptId: String(detail.attemptId),
          onlyIfStalled: true,
          reason: "no progress for " + String(detail.stallMinutes) + " minutes",
          idempotencyKey: "stall:" + String(detail.attemptId),
        });
      },
    }),
  ],
}));
\`\`\`

### A chat per Slack thread

Mentions of the Slack app become one project chat per thread, keyed
\`slack:<channel>:<thread_ts>\`, and the agent's settled reply is posted back
to the thread by a second automation reacting to \`session.turn-changed\`.
Both recipes, with the trigger library they bind, are in the \`slack\` skill.

## Directory events

On a Work server, people joining and leaving start workflows:
directory.member-joined (an account's first sign-in, or a sign-in after the
directory restores it), directory.member-left (the account is disabled:
suspended, deleted, or outside every required group), and
directory.groups-changed. A workflow binding them must declare
\`memberships:read\`. input.payload.member is { id, email, name, domain },
input.payload.groups the member's groups (lowercased), and groups-changed adds
added and removed. Config { groups: ["eng@example.com"] } selects members of
any of those groups (on groups-changed, changes that add or remove one); where
on payload.member.domain selects one domain. Only projects with the automation
turned on receive them, each change once; nothing from before it was turned on
is replayed.

host["catamorphic.secrets"] sets and deletes a member's own value of a declared
project secret (\`secrets:write\`), naming them by email or id; Environments
that list the secret hand each member their value. Issue a credential and
return the set call from the same boundary, so the value is never a boundary's
output (the run keeps those). A key per engineer, revoked when they leave:

\`\`\`typescript
import { type BoundaryContext, defineSecrets, defineWorkflow, type TriggerPayload, trigger } from "@catamorphic/workflow";

export const secrets = defineSecrets({
  CLICKHOUSE_ORGANIZATION_ID: { description: "The ClickHouse Cloud organization that issues keys" },
  CLICKHOUSE_ADMIN_KEY: { description: "A ClickHouse Cloud key that manages keys, as keyId:keySecret" },
});

/** Where the organization's keys live, and the admin key's credentials. */
function keysApi() {
  return {
    url: \`https://api.clickhouse.cloud/v1/organizations/\${secrets.CLICKHOUSE_ORGANIZATION_ID}/keys\`,
    headers: {
      authorization: \`Basic \${Buffer.from(secrets.CLICKHOUSE_ADMIN_KEY).toString("base64")}\`,
      "content-type": "application/json",
    },
  };
}

/**
 * @displayname Revoke ClickHouse keys
 * @icon key-round
 * @param email - @displayname Email | @description Whose keys to revoke
 */
async function revokeClickHouseKeys({ email }: { email: string }) {
  "use step";
  const { url, headers } = keysApi();
  const listed = await fetch(url, { headers });
  if (!listed.ok) throw new Error(\`Listing ClickHouse keys failed: \${listed.status}\`);
  const { result } = (await listed.json()) as { result: { id: string; name: string }[] };
  const keys = result.filter((key) => key.name === \`work \${email}\`);
  for (const key of keys) {
    const revoked = await fetch(\`\${url}/\${key.id}\`, { method: "DELETE", headers });
    if (!revoked.ok) throw new Error(\`Revoking ClickHouse key \${key.id} failed: \${revoked.status}\`);
  }
  return { revoked: keys.length };
}

/**
 * @displayname Issue a ClickHouse key
 * @icon key-round
 * @param email - @displayname Email | @description Who the key is for
 */
async function issueClickHouseKey({ email }: { email: string }) {
  "use step";
  const { url, headers } = keysApi();
  const created = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: \`work \${email}\`, roles: ["developer"], state: "enabled" }),
  });
  if (!created.ok) throw new Error(\`Issuing a ClickHouse key failed: \${created.status}\`);
  const { result } = (await created.json()) as { result: { keyId: string; keySecret: string } };
  return \`\${result.keyId}:\${result.keySecret}\`;
}

/** @displayname Issue engineers their ClickHouse key */
export const issueEngineerKeys = defineWorkflow(({ defineBoundary }) => ({
  permissions: ["memberships:read", "secrets:write"],
  triggers: [trigger("directory.member-joined", { groups: ["engineering@example.com"] })],
  steps: [
    /** @displayname Issue and store the key */
    defineBoundary({
      run: async ({ input, host }: BoundaryContext<TriggerPayload<"directory.member-joined">>) => {
        const { email } = input.payload.member;
        // A retried run must not leave a second key behind.
        await revokeClickHouseKeys({ email });
        const value = await issueClickHouseKey({ email });
        return host["catamorphic.secrets"].set({ name: "CLICKHOUSE_API_KEY", value, member: email });
      },
    }),
  ],
}));

/** @displayname Revoke leavers' ClickHouse keys */
export const revokeLeaverKeys = defineWorkflow(({ defineBoundary }) => ({
  permissions: ["memberships:read", "secrets:write"],
  triggers: [trigger("directory.member-left", { groups: ["engineering@example.com"] })],
  steps: [
    /** @displayname Revoke their keys */
    defineBoundary({
      run: async ({ input }: BoundaryContext<TriggerPayload<"directory.member-left">>) => {
        const { email } = input.payload.member;
        await revokeClickHouseKeys({ email });
        return { email };
      },
    }),
    /** @displayname Delete their stored key */
    defineBoundary({
      run: ({ input, host }: BoundaryContext<{ email: string }>) =>
        host["catamorphic.secrets"].delete({ name: "CLICKHOUSE_API_KEY", member: input.email }),
    }),
  ],
}));
\`\`\`

Enable both as project automations. Declare CLICKHOUSE_API_KEY in
\`.work/project.json\` \`secrets\` and list it in the Environments whose
sandboxes need it.

## Session actions and delivery

- read and list are authorized reads. read answers with the chat's state;
  include: ["transcript"] adds its messages as transcript. It is bounded;
  increase limit only when needed. Read a child as an ordinary session. The
  state carries the chat's key, and through: "<messageId>" ends the
  transcript at that message, so a workflow on session.turn-changed reads
  exactly the reply the event's detail.resultMessageId names, even after
  later turns.
- read with include: ["results"] reads the typed values an agent submitted
  with submit_result (ADR 0323), newest first: { sessionId | key, name?,
  family?, turnId?, afterInput?, limit?, order? } (order: "oldest" reads the first submitted
  first). An agent submits only results its committed definition declares
  (\`"results": { "<name>": <JSON Schema> }\` in .work/agents/<slug>.json),
  and only a value its schema accepts is recorded, so read results, never
  parse a reply. Each result names its chat (family: true adds subsessions at
  every depth), turn, input (the newest message the chat had taken in when it
  was submitted, with its kind), commit and recordedAt. current is true while
  no new request reached the chat since: a person's message, or words from a
  workflow or a session outside the chat's own subsessions. Task notifications
  and its subsessions' messages are its own work and keep it current. Pass
  afterInput: <the messageId your deliver returned> to keep only results that
  answer it, or turnId: <the settled turn's id> to read what that turn
  submitted, whatever came after it. session.result-recorded fires
  the moment one is recorded, mid-turn, with the result in input.payload.detail
  (name, value, turnId, input, commit); select { names: ["review"] }. The
  pull-request-reviews pack posts each verified finding that way, in the same
  per-key queue as the turn's review. A turn makes at most 100 submissions,
  rejected ones included, so one read of a turn's results holds them all.
  Compute final checks (votes, coverage) in code over results, not in an
  agent.
- read with include: ["usage"] is an authorized read of a chat's model calls through the gateway:
  tokens per model, the summed cost providers reported (costUsd, US dollars,
  null when none did), unpricedCalls (so the cost is a lower bound when
  above zero), unmeteredCalls (calls whose usage could not be read, so the
  tokens are a lower bound too) and openCalls still streaming. family: true
  adds the subsessions below the chat that the caller may read. Work keeps no prices and no budgets: a project
  that wants a limit or a report computes it from this.
- deliver message_only records it without a model turn: people see it at
  once and the agent reads it with its next turn. queue starts work when idle
  or queues behind the active turn; steer adds the message to the turn working
  now (it queues when none is); interrupt stops the active turn and runs this
  next. The chat shows it as the workflow's message, never the person's, and
  the agent reads it in a <workflow-message> envelope (ADR 0217). Authoring a
  workflow message does not grant system/developer instruction rank.
- deliver names its chat one of two ways. sessionId reaches that exact chat.
  key reaches the chat this workflow keeps for the key: the first delivery starts
  it (with agentSlug, title and environment when given) and later ones reuse it,
  so "pr-" + number gives one chat per pull request and "daily" one recurring
  chat. A keyed chat alerts its people when the agent's turn settles; pass
  notification { title, body } to word that alert, or to alert on a chat named by
  sessionId. Who a keyed chat belongs to follows the enablement: a member's
  automation reaches that member's own chat; a project automation reaches a
  project chat that everyone whose role reaches the agent can read and continue,
  or one member's chat with audience: { member: "<id>" } (a current member; use
  an id from an event or a lookup, never a guess). A project chat runs as the
  project, not as any person: it runs in its agent's Environment and uses that
  Environment's committed service bindings (never a member's connection), so
  the agent definition names the aliases it needs. Reaching a chat that
  is not the run's own (another member's by sessionId or audience) needs
  \`sessions:write\` in the workflow's \`permissions\`; the project chat from a
  member's automation needs \`automations:write\`. Listing everyone's chats
  needs \`sessions:read\`.
- No one watches a project chat, so name who approves for it: approvers
  { members: ["<id>"], roles: ["<role>"] } on deliver (a pull request's author
  and reviewers, an on-call role). When its agent needs approval (a query a
  server guard escalates, a tool set to ask) they are notified and answer from the chat, and
  only they can; the agent waits for the Environment's approvals.waitMinutes
  (30 by default), then continues without it. Without approvers such an
  action is refused at once, unless a project workflow answers it (below).
- A workflow answers what an agent asks. session.request-opened fires when an
  agent asks for something its turn waits on: an approval (a tool set to ask, a
  harness's own permission prompt, a server guard's escalation), a question or
  an elicitation. detail has requestId, kind, title, description, origin,
  approval { action, details, tool { server, name, input } }, questions,
  elicitation, turnId and expiresAt. Decide in code and return
  host["catamorphic.sessions"].answer({ sessionId: input.payload.sessionId,
  requestId: detail.requestId, response: { kind: "approval", decision:
  "approved" | "denied", reason }, idempotencyKey: input.id }). While a project
  automation is bound to the event (its config and where matching the chat),
  an approval in a chat no one watches waits for its answer, two minutes by
  default or the Environment's approvals.waitMinutes, and its subsessions'
  approvals do too. Answer every request you receive, denied with a reason the
  agent can act on when it should not run: an unanswered one holds the turn
  until it expires. Only a project automation answers a project chat's
  approvals this way; a member's own automation cannot. Narrow with where: {
  payload: { detail: { kind: "approval" } } } or config agentId. tool.input is
  what the agent sent, written by an agent that may have read untrusted
  content: match exact tools and arguments, never approve by default.
- workspace on deliver (ref on start and send) starts a chat's checkout at a ref of the
  project's linked remote: a branch, tag, commit, or full ref such as
  refs/pull/42/head. The host fetches it with the remote's own credentials; the
  sandbox never holds them. Delivered again to an open chat it moves the
  checkout before the next turn: update "rebase" (default) keeps the agent's
  work on top of the new base, "reset" discards it. The agent is told what
  changed, and a conflicting rebase changes nothing and says so. A chat
  working in a person's own project folder first gets its own worktree; that
  folder is never reset.
- Git inside a chat's sandbox reaches remotes through the gateway when the
  chat's Environment binds a Git connection (a binding with git.repositories
  and git.push rules): plain git fetch and git push origin work, with the
  session's grant, never the remote's credential. Pushes go to work/* branches
  (or the binding's push rules); the default branch, deletes, and anything
  without git:write are refused with a readable Git error.
- spawn starts a copy of the chat's agent unless agentId names another, and
  takes model and effort as the agent's delegation grants allow (a copy keeps
  the chat's model and effort otherwise); readOnly and delegate: false need no
  grant. The child works in the chat's workspace (workspace: "shared", the
  default: its files as they are, nothing set up again); workspace: "own"
  gives it one of its own started at the chat's base, for children that
  write in parallel. Each result the child reaches later, woken by its own
  background command or a message, reaches the chat too. Fresh context
  is the default. fork explicitly copies transcript history; start makes an
  independent conversation and gives it its first message. Do not simulate
  children as untracked shell agents.
- attention: "required" on deliver alerts the user to that exact message. It is
  independent of mode and defaults to none. Use message_only for a reminder to
  the user; use queue for work the agent should perform. Do not run a model
  merely to display a reminder. Notification preferences affect alerts, not the
  retained message or its unread attention. Repeated delivery with the same key
  creates one message and one attention request.
- archive stops the session tree's work and future temporary activations while
  preserving readable history. Follow archive preview and confirmStop requirements for stopping live work. Tab closure is
  unrelated. stop stops only the calling temporary activation and retains runs.

read with include: ["metadata"] returns the chat's metadata: named JSON
values agents, people and workflows set (ADR 0226). setMetadata({ sessionId | key, set }) applies a
merge patch: each key in set takes its value whole, null removes it, and keys
not named stay. Keys are lowercase words joined by _, - or . (at most 32 keys,
16 KB a value, 64 KB in all). Prefix the keys a workflow owns with its purpose
(review.verdicts), and leave other keys alone. Closed and archived chats still
take writes; only the host holding the chat's authority writes it, so a call
elsewhere fails and the boundary retries. The same write twice changes
nothing, so it takes no idempotencyKey. Queue the workflow per chat
(concurrency, see writing-workflows) when it reads a key and then writes it.

Use stable idempotencyKey values for operations that take them. deliver
defaults to one delivery per run, chat and content, so a retried boundary never
posts twice; pass a key when the same text must arrive twice in one run, or to
tie delivery to an event. Reuse the same action key for retries of the
same action; use a different key for a new action. Do not use a fresh random key
on each boundary retry. Prefer event identity or activationId + scheduledFor.
Causal chains prevent self-triggering and bounded multi-workflow loops; do not
attempt to evade that protection by discarding provenance.

## Placement and verification

Reusable project workflows can observe a trigger or target a session on another
host. Session-owned watchers still run on their owner's host and Environment.
Remote delivery may remain queued while a desktop is offline. It does not
move session authority. A remote mutation returns delivery: "queued" and a messageId,
not the completed action result or a newly created child. Branch on that receipt
before using a fork/spawn result; read the chat or watch for the resulting event.
Inspect the returned receipt and retained run rather than
claiming the user or model received a queued message already.

Before reporting an automation active, inspect its enabled status, source revision,
Environment, expiry, and next intended behavior. Check authored source with the
project checker. Verify one real occurrence or controlled event, including the
quiet path. Ensure a finite monitor stops itself, and show the user its workflow
or artifact link. Never introduce permanent polling to satisfy a one-time wakeup.
`;
