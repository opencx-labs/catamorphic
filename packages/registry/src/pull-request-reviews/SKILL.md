---
name: pull-request-reviews
title: Pull request reviews
description: How this project reviews its pull requests: a review chat per pull request on the review pool, its Environments, reviewer and doctrine, the workflow that shows each review in progress and posts its findings as they are verified, then the review, check run and replies, to GitHub, and an optional one that restarts a stalled review. Use when adapting, debugging, or explaining the reviews.
---

# Pull request reviews

This project reviews its pull requests with its own code, installed from the
`pull-request-reviews` pack and the team's to change: the GitHub trigger
library, a `review` Environment with its own image and read-only bindings, a
`github-poster` Environment for workflows only, a `reviewer` agent whose
persona is the review doctrine, five workflows, and an optional sixth that
restarts a review that stopped making progress. With the workflows on,
every non-draft pull request gets a project chat keyed
`pr-<repository>-<number>`:

- **Opened, reopened, ready for review:** the chat starts in the `review`
  Environment on a machine of the review pool, with its workspace checked out
  at `refs/pull/<number>/head`. Within a minute the "Work review" check shows
  the review in progress: waiting to start, preparing the workspace, then
  reviewing (ADR 0337).
- **While it reviews:** the agent submits each finding it has verified as a
  typed `finding` result (`submit_result`, ADR 0323), and `postReviews`
  posts it at once as an inline comment.
- **The turn ends:** the agent submits its `review` result, without
  repeating its findings; `postReviews` checks it and posts the review with
  the turn's findings not posted yet, completes the "Work review" check run
  with the verdict, and posts replies, from the control plane. The review is
  advice: the pull request's code ran beside it.
- **A new push:** the same chat moves to the new head (`update: "reset"`) and
  is told what changed, so it reviews the difference; the next report
  explains which findings the new head fixes. The earlier head's check, if
  still in progress, is cancelled, and nothing more posts for it. People
  retain control of earlier change requests and threads.
- **A comment mentioning `@work`:** delivered to the same chat; the report's
  `reply` is posted as the answer.
- **Closed or merged:** `close({ key })` ends the chat: its workspace,
  containers, session branch, and grants are released; the transcript stays.
  A check still in progress is cancelled.

The review chat never writes to GitHub (ADR 0259). The reviewer, the
built-in agent, runs on the control plane; its tools and the pull request's
own code (its install scripts, tests and services) run in a command
container (ADR 0332), which holds none of the reviewer's grants, model or
Work tools, so that code cannot call them as the chat, submit a forged
`review`, or change the files the reviewer trusts. That code reaches Git
reads through the gateway, which `commands.connections` lists, and nothing
else of the chat's. The chat's `github` binding only
reads all the same (no `git:write`: a push would run the base repository's
`on: push` workflows with their secrets) and its sandboxing is `contained`.
Whatever the reviewer submits is a report the poster validates, never a
post. Credentials never reach the review machines either: the App's key, the
replica's password, and Slack's token stay on the control plane, and Git
fetches with the session's grant.

The review is advice, not a merge gate. The pull request's code can no
longer reach the reviewer, but the reviewer reads what the pull request
wrote, so hostile content can still mislead it about the verdict, the "Work
review" check, and replies. Protect the base branch with a person's
approval, and if you require the check, require it from the App so a run
another workflow names alike does not count.

On a server GitHub cannot reach (no public webhook URL), the
`github-polling` pack's `pollGithub` polls the repository and records the
same `github.*` events (ADR 0326); every workflow here runs on them
unchanged, and the webhook secret is not needed.

The server side (the GitHub App and its webhook, the service connections, the
review machines) is the Work server guide's "Review pull requests with Work";
point whoever runs the server there. `writing-workflows` explains triggers
and `where`, `session-workflows` keyed chats and workspaces.

## .work/project.json

In `review`, `pool` places the chats on machines
enrolled with the label `pool=review` (opened to this project), which a
machine rule can create on demand (on AWS, the `machines-ec2` pack makes
them through a `workflow` machine class). The image brings Git, Node, Bun, pnpm,
and Docker; `containers` lets the agent run the change's services with
Docker Compose inside its own sandbox. The agent's sandbox reaches only the
control plane's gateway (`egress: gateway`): GitHub and the other
bindings, and its model.

`commands` runs everything the reviewer runs (its tools, setup, `exec`,
terminals, the change's tests and Compose services) in a command container
that reaches only the connections it lists (ADR 0332). For the built-in
reviewer that container is the whole sandbox; a reviewer whose harness
runs in the sandbox (Claude Code) gets a container of its own beside it,
sharing only the checkout. Docker runs in the command container. Its one connection is `git`, a
binding of its own with `git:read` alone, which reaches only the project's
linked repository (a binding's default), so its commands (and `exec` from
workflows) can `git fetch`; the reviewer's `github` binding keeps the
GitHub reads and gives the commands nothing. Add another binding only when
the change's tests need it, and never a write one. `requirements.resources` limits the command container;
a reviewer whose harness runs in the sandbox takes `commands.agentResources`
(1 CPU and 2 GiB by default) on top for its own, and a machine reserves
both. The built-in reviewer reserves nothing more. Only container machines (the Work server's
`WORK_SANDBOX=container`, gVisor or runc without privileged containers)
take this Environment.

`setup` installs the change's dependencies and pulls its Compose images
before the first turn and after each push, in a sandbox of its own that
reaches only the registries listed and holds the checkout alone, with no
grant or secret (ADR 0257). The command installs with pnpm, Bun, or npm,
whichever lockfile the change has, and pulls the Compose file's images
(one it cannot pull is left for the agent to report); replace it with the
repository's own install, and add every host the install reaches (a
private registry and the secret it needs in `setup.secrets`, a binary
host such as `binaries.prisma.sh`, another image registry). A setup that
fails runs again before every turn, each time in a new sandbox, so a host
missing from the list costs every turn. With a setup network the
Environment keeps no volumes: what the pull request's install scripts write
must never reach the next review.

`caches.pnpm` is a pnpm store every review sandbox mounts read only, setup's
included, at `~/.cache/work/pnpm-store` (ADR 0334). Only a fill writes it:
Work runs the cache's own `fill.command` (`pnpm fetch`), as the revision
of main that last went live declares it, in a fresh sandbox holding that
revision alone, on its setup's network with nothing else,
and publishes the new store only when the fill succeeded and its sandbox is
gone. Setup lays a writable store over it (an overlay, which the review
sandbox may mount because it runs its own Docker) and installs with
`--prefer-offline`: what main already had comes from the cache, and only
what the pull request adds is fetched, into the overlay's upper layer in
the workspace, never into the cache. A sandbox that cannot mount installs
offline from the cache and falls back to the registries, so there a pull
request that changes the lockfile downloads everything. Copies live on each machine: the first review on a new
machine installs from the network while Work fills that machine's copy, and
machines kept idle (`machines.demand.min`) stay warm. `sizeMb` bounds a
fill, and a fill reserves it on its machine (ADR 0336): it starts only
while the machine's free disk less `sizeMb` stays above its floor, so size
it to the machines (the pack's 16 GiB suits machines of about 100 GB). A
copy no review mounted for 30 days is evicted. Each copy holds
`.work-cache.json` saying which commit of main filled it and when, and the
agent is told the same. The pack caches pnpm's store, which pnpm installs
from read only; check that another package manager does before declaring
its cache.
`waitMinutes` lets a new review wait for a
machine (one made on demand takes a few minutes) instead of failing.
`idleReleaseMinutes` gives a quiet review's machine back and rehydrates it
on the next push. `approvals.waitMinutes` is how long an escalation waits
for the pull request's people.

The bindings name service connections an administrator set up. In `review`:
`github` (the GitHub App installation; reads and review threads), `git`
(the same installation for Git fetches of the repository, the only binding
the change's commands reach), `prod` (a read-only role on a production replica: `query`,
`explain`, `schema`), and `slack` (a user token for `search.messages` and
`conversations.replies`). Leave out what the organization does not have; the
agent treats `prod` and `slack` as optional. `github-poster` runs no
agent and binds the same `github` connection with the typed actions the
poster writes with; none of them is a raw REST write verb. Publication creates
commit-bound
reviews and checks, updates the checks it made, and posts stamped replies. It does not mutate descriptions,
dismiss earlier reviews, or resolve threads.

Fix branches are left out on purpose. Adding `git:write` to `review`
would let the pull request's code push with the chat's grant: a fork's
commits into a `work/*` branch of the base repository, where pushes made
with the App's token run its `on: push` workflows with the base
repository's secrets. A team that wants the reviewer's fixes pushed should
give them to a separate chat that never runs the pull request's code (it
edits and pushes, and installs nothing), in its own Environment with
`git:write` and `git.push` limited to `work/*`, and keep `on: push`
workflows from running secrets on `work/*` branches.

## .work/images/review.Dockerfile

Git, Node, Bun, pnpm, and Docker on `docker:dind`. Add the toolchains the repository needs (a Go, Python, or Java toolchain,
browsers for end-to-end tests). The build context is the Dockerfile alone.

## .work/triggers/github.ts

The GitHub library from `writing-workflows`, with `github.pull_request`,
`github.issue_comment`, and `github.pull_request_review_comment`. Its
signing secret is `GITHUB_WEBHOOK_SECRET`, used only to verify deliveries.

## .work/agents/reviewer.json

The reviewer runs only in `review`. Sandboxing `contained` lets nothing
leave its sandbox (no push, proposal, or publish, and connection actions
only read), whatever its bindings say. Its GitHub tools are reads, an
allowlist on top of the binding.

Its `results` are the JSON Schemas of what it reports: `finding`, one
verified problem (`id`, `path`, `line`, optional `startLine` and `side`,
`severity`, `title`, `body`), and `review`, the verdict, score, summaries
and an optional reply. The agent
submits them with `submit_result`; Work records only a value its schema
accepts and sends each failing field back to the agent in the same turn, so
a malformed report is fixed before the turn ends instead of being lost.
Change the schemas together with `review-report.ts`, which checks each value
again before posting. A turn makes at most 100 submissions, refused ones
included (ADR 0323), so one read holds every finding it made and a chat
that lives as long as its pull request never runs out; the poster posts a
turn's first 30 findings (a commit holds 30) and says exactly how many more
there were. Patterns in the schemas keep ECMAScript's meaning but run on a
linear-time engine (RE2): one with a backreference or lookaround, or one
that compiles to more than 2,000 instructions, is refused when the reviewer
loads, and text over 4,096 code points where a pattern applies is refused.
The shipped ones say "not blank" as `\S`, which means what the poster's own
check means.

Its `stall` (`{ "minutes": 20 }`) is how long a review turn may make no
progress (nothing from its harness but log lines, no model call) before Work
records a stall and emits `session.turn-stalled` (ADR 0333). Its subagents'
progress counts: a reviewer waiting on subagents that work does not stall. Work only
reports it; `restartStalledReviews` acts on it when it is on. Raise it for
reviews that legitimately sit in one long command (a full test suite), or
remove it to record no stalls.

## .work/agents/reviewer.md

The review doctrine. Edit it to match the team: what matters in this
codebase, which tests are slow, what never to touch.

## An open model: OpenCode

The `pull-request-reviews-opencode` pack makes the reviewer OpenCode, which
Work runs as an ACP agent in the same sandbox (ADR 0255), on an open-weight
model through OpenRouter or another OpenAI-compatible API.

Its reviews are not protected from the code they review. OpenCode loads
plugins from the checkout (`.opencode/plugin/`, `.opencode/plugins/` and the
`plugin` list of an `opencode.json`) whatever its settings say, so it cannot
run apart from the change's code (ADR 0332): Work refuses it in an
Environment that runs commands apart, and its install removes `commands`
from the `review` Environment. There the pull request's code runs beside
the reviewer, plugins it plants included, and can reach the model key and
the tool the reviewer submits its review with. Where that matters, keep this
pack's own reviewer, the built-in agent: it runs on the control plane, so
the model key and Work's tools never enter the machine, and its tools run
in the command container. The rest of the pack applies unchanged:
the `review` Environment's read-only pnpm cache and `fillReviewCache`, and
`restartStalledReviews` (the OpenCode reviewer sets `stall` too).

The image still turns off what OpenCode would otherwise start or read from
the checkout: language servers and formatters (`"lsp": false`,
`"formatter": false`, some resolve from the change's own dependencies), Git
snapshots (`"snapshot": false`), language server downloads, and the
change's Claude Code files and external skills. Its image points OpenCode
at `WORK_MODEL_BASE_URL` and `WORK_MODEL_API_KEY`: Work serves the model
connection on the sandbox's loopback for each turn, so no key reaches the
machine. `OPENCODE_DISABLE_PROJECT_CONFIG` keeps the pull request's own
OpenCode settings and `AGENTS.md` out of the reviewer's instructions: the
doctrine comes from `reviewer.md` alone. Which providers serve
the prompts, with no fallbacks and no data retention, is the server's: a
rewrite in its own image (the Work server guide's "Harnesses on the server").

Add `"effort"` to `reviewer.json` to pick among the model's variants (the
chat says so when the model has no such level). OpenCode keeps its session in
the sandbox, so a chat whose sandbox was replaced (idle release, a lost
machine) starts a new OpenCode session: its hand-off carries the latest
result of each name the chat already submitted (its `review` and its newest
`finding`) and the pushes and comments no result answers yet, verbatim (ADR
0328), so nothing the reviewer must act on is summarized away. The findings
it already posted are on the pull request: the doctrine has it read them
with `review_threads` before it submits more.

## .work/workflows/src/reviews.ts

Every trigger's `where` names the repository this project is attached to,
and so does `REVIEWED_REPOSITORY`, which `postReviews` posts to. The App's
webhook delivers events from every
repository the App is installed on, while a review chat's workspace fetches
from the project's own remote, so a filter naming another repository (or
none) reviews the wrong code.

`GITHUB_MEMBERS` maps GitHub logins to project members: the author and
requested reviewers who are mapped approve the chat's escalations (a query a
server guard escalates, a tool set to ask); with nobody mapped the `reviewers` role does, so
commit a `reviewers` role or map people. A mapping names who may approve; it
never gives the chat anyone's access. The chat itself runs as the project,
with the `review` Environment's service bindings.

`answerReviewComments` starts a run for every person's comment on a pull
request (`where` cannot search text) and delivers only those that mention
`@work`; comments from bots, including the App itself, start nothing.
Deliveries are keyed by GitHub's delivery id and comment id, so a redelivered
webhook adds nothing. `postReviews` is the one workflow holding a
connection; enable it in `github-poster` so its runs use that
Environment's binding.

`fillReviewCache` asks Work every six hours to fill the `review`
Environment's pnpm store from the revision of main that last went live
(`host["catamorphic.environments"].fillCache`, `permissions:
["caches:write"]`). It names only the Environment and the cache: the command
is the one `.work/project.json` declares at that live revision, so no
workflow and no pull request chooses what runs with the store writable. A
revision fills only once it went live: a deploy workflow (ADR 0331) runs
before its own revision does, so it cannot fill from it; the next scheduled
fill takes it.

## .work/workflows/src/review-report.ts

Pure helpers `postReviews` checks a review and its findings with, with no
IO, so a retried boundary computes the same thing. The `review` result has
one full commit, a COMMENT or REQUEST_CHANGES verdict, a score from 1 to 5,
summaries up to 4,000 characters, and an optional reply. A `finding` has an
id of letters, digits, `.`, `_` and `-`, a path, a line (or a range ending
there), a side, a `blocking`, `important` or `minor` severity, a title up to
200 characters and a body up to 1,500. Unknown fields, including the old
`comments` and `resolve`, are rejected. Text shaped like the stamp, so it
cannot forge one, and characters that reorder or hide text (direction
controls, tag characters), so a suggestion cannot read one way and apply
another, are refused when the reviewer submits them: both schemas refuse
them in every text field, saying what to leave out, so the reviewer
corrects the field and submits again, and the poster refuses them again
anywhere in a value. `turnFindings` picks a turn's first 30 distinct valid findings,
each as first submitted, and counts the distinct ones after them.

Each body is defused whole as it is posted (a finding's inline comment, the
review, a check's summary, a reply), read as GitHub reads it (CommonMark
with GitHub's extensions, through `mdast-util-from-markdown`): code blocks,
suggestions included, and code spans are posted exactly as written.
Everywhere else every `&` and `<` is escaped, so no HTML or entity is
interpreted; every `@` stops notifying, except in a link's destination and
in an autolink such as `<name@example.com>`; links drop their titles,
images become links, link reference and footnote definitions show as text,
and invisible characters are written out as `\u{…}`. A body is cut to fit
GitHub after this, and one over 16 KB, or nested deeper than any review
needs, is escaped whole, its formatting shown as text. The markers and
stamp a body carries follow it as written.

Updating an installed pack: this file reads Markdown with three packages,
`mdast-util-from-markdown`, `mdast-util-gfm` and `micromark-extension-gfm`,
at the versions the manifest pins. Add them to `.work/workflows/package.json`
when you update this file, or the workflows do not deploy.

## .work/workflows/src/stalled-reviews.ts

Optional: `restartStalledReviews` runs on `session.turn-stalled` for this
repository's review chats, one stall per chat at a time. A review whose
agent hangs (a tool call that never returns, a harness stuck on its model)
otherwise keeps its turn, and the pull request its "Work review" check,
until someone stops it. For each stall it:

1. Inspects the chat, and does nothing unless it is this repository's review
   chat exactly (its key names a pull request of `REVIEWED_REPOSITORY`, and
   it is the reviewer's project chat in `review` that `reviewPullRequests`
   started, as `postReviews` checks), and the stalled attempt is still the
   turn's and still silent.
2. Reads the turn's attempts with `attempts`: each one's outcome and the
   tails of its runner's and harness's own output Work kept, masked. That is
   its only evidence: a command run in the review's workspace would print
   what the pull request's code wants, and may run apart from the agent,
   seeing neither its processes nor its logs.
3. Writes it to `store/reviews/stalls/<number>/<attempt>.json`. The
   workflow declares that folder in `documents` (ADR 0335): turned on for
   the project, its runs reach only it of the store.
4. Inspects the chat again, and acts only if that attempt is still stalled.
5. Restarts that attempt (`restart` with its `attemptId` and `onlyIfStalled`,
   keyed by it, so a retried run restarts once): Work ends it without asking
   its harness, revokes its model grant, and runs the same turn again,
   telling the agent it was restarted and to check what it already did. A
   restart Work refuses (the attempt moved on) is nothing to do. After
   `MAX_RESTARTS` (2) restarts of a turn it stops that turn instead
   (`interrupt` with its `turnId`), and `postReviews` marks the commit
   `action_required`: "The review turn was stopped before it finished."
   A stopped turn that had already submitted its review for the head
   publishes that review instead.

It declares `sessions:write`, which `restart` and `interrupt` need on the
project's chat; whoever turns it on needs that permission too. It is the
place to change the policy: skip a stall whose `activity` shows a command
that is expected to be slow, change the bound, or notify someone instead of
restarting.

## Optional: a trusted procedure, and pushes during a review

Two patterns the pack leaves out, for a team whose reviewer reads its own
procedure files (skills, prompts, scripts) from the repository, or whose
reviews are long enough that pushes land while one runs. Both use `exec`
and setup workflows (`session-workflows`, ADR 0324).

**The review procedure comes from the program, not the pull request.** Name
a setup workflow beside the command, `"setup": { "command": "...",
"workflow": "prepareReview" }`, and enable it for the project with
`permissions: ["sessions:write"]`. Work runs it in every new review
workspace, after each move to a new head and when the setup changes, and the
turn waits for it. It returns one `exec` with `in: "session"`, from the
checkout:

```sh
rm -rf .work/skills/review .work/agents/reviewer.md
cp -R "$WORK_PROGRAM/skills/review" .work/skills/review
cp "$WORK_PROGRAM/agents/reviewer.md" .work/agents/reviewer.md
chmod -R u+w .work/skills/review .work/agents/reviewer.md
```

`$WORK_PROGRAM` is the run's `.work/` folder at its deployed commit, so the
pull request cannot change how it is reviewed by editing these files in its
diff. A second `exec` can write prepared facts the agent reads (the
description, the discussion, CI results fetched by an earlier step) into
files beside them.

With `commands` apart, copies in the checkout are only as trustworthy as
the checkout: the change's code runs there after setup and can rewrite
them. Where the reviewer's harness runs in the sandbox in a container of
its own (a project's own Claude Code reviewer), Work places the same program
there too, at the same path (`/workspace/.work-program/<commit>`), where no
command reaches it. A setup `exec` that prints `$WORK_PROGRAM` returns that
path; deliver it to the chat so that reviewer reads its procedure there with
its own file tools. The built-in reviewer runs on the control plane and its
tools work on the command side, so its procedure belongs in its persona or
the delivery itself. The OpenCode reviewer runs without `commands` apart,
beside the change's code, so no copy is out of that code's reach.

**A push lands while the review runs.** Rather than moving the checkout
under the agent and its subagents, the push workflow compares the new head's
lockfiles with the checkout's, with `exec` `in: "session"` (the chat's own
network fetches through the gateway):

```sh
git fetch -q origin "$SHA" && git diff --quiet HEAD "$SHA" -- pnpm-lock.yaml '**/package.json'
```

- **Lockfiles unchanged (exit 0):** a second `exec` adds the head beside the
  checkout and reuses what setup installed, then the workflow steers the chat
  (`deliver` with `mode: "steer"`) with the path:

  ```sh
  git worktree add -q --detach ".versions/$SHA" "$SHA" && cd ".versions/$SHA" && pnpm install --offline --frozen-lockfile
  ```

  `--offline` resolves from the store setup filled, so nothing is fetched
  from a registry the chat's network does not reach. Add `.versions/` to the
  checkout's `.git/info/exclude` in the setup workflow, so it stays out of
  the chat's saved work.
- **Lockfiles changed (exit 1):** new dependencies cannot be installed while
  a turn runs: a sandbox in use never gets the setup's network (ADR 0257).
  Deliver `workspace: { ref: "refs/pull/<number>/head", update: "reset" }`
  with `mode: "steer"` and content telling the agent the workspace moves to
  the new head after its current turn, so it wraps up. The move runs setup
  again on the new base before the next turn.

What this protects, honestly: with `commands` apart, code the pull request
runs reaches only the command container, so the reviewer's own program copy,
grants and tools are out of its reach; the copies in the checkout are not.
What the pull request wrote still reaches the reviewer as content and can
mislead it. The review stays advice, and the poster validates every report
outside the sandbox (ADR 0259).

## How reviews reach GitHub

`postReviews` is ordinary workflow code; nothing is installed into the
server. It runs on this repository's review chats' turns (`queued`,
`preparing` and `running` show the review in progress; `completed`,
`failed`, `interrupted` and `cancelled` settle it) and on each `finding`
result the moment it is recorded (`session.result-recorded`). It declares
`concurrency: { key: "payload.session.key", onConflict: "queue", coalesce:
["kind", "payload.detail.turnId", "payload.detail.status"] }`: publications
for one pull request chat take turns, each starting only after the one
before it has finished, holding no machine while it waits (ADR 0325), and
an event alike one whose publication still waits joins it instead of
queuing another (ADR 0337): a turn's findings (which carry no status) join
one waiting publication, and a turn's statuses one each. A publication
takes nothing from its event but its kind, turn and status, which are what
make events alike, and reads the chat, its results and GitHub when it
starts, so it answers every event that joined it, in any order. A key
never fills the 100 runs it may queue: the turn's verdict always gets in.
Publications for different pull requests run side by side.

The queue keeps two publications from writing at once, so two overlapping
turns never both read "no verdict" and post a failure and then a success.
It does not promise the order events happened in (replicas, retries and
joining can reorder them), so what keeps progress from overtaking a verdict
is in the publications themselves: progress never writes on a commit that
has a verdict, rewrites a run only after reading it by id and never once
completed, every write checks GitHub's head first, and findings are found
by their markers wherever they were posted. GitHub alone says what was
posted and which runs are in progress; nothing the chat records decides
either.

Each boundary returns one call and carries the publication to the next:

1. Inspect the chat: only the reviewer's project chat in `review` that
   `reviewPullRequests` started posts anything. Its workspace commit, its
   working turn, and what earlier publications recorded on it, come from the
   chat itself.
2. Read what the turn submitted (`results`, ADR 0323): for a settled turn,
   the newest `review` it submitted, from any of its attempts (a sandbox
   lost after the review was submitted does not lose it), and the turn's
   `finding` results, first submitted first (`order: "oldest"`, its first
   100); for a finding, the same findings. The turn's state comes from the
   chat (`turn`, at work, and `queued`): a status whose turn no longer works
   or waits shows nothing. No review, or a
   turn that failed, means no pass; a stopped turn publishes the review it
   submitted, and with none means no pass. Two commits must both be the
   head it posts for: the one the review names (`reviewedCommit`) and the
   one Work recorded the turn began on (the result's `commit`). Either one
   elsewhere refuses the review: the commit is marked `action_required` with
   which one differed, unless another turn of the chat works or waits,
   which then speaks for the head.
3. Read the pull request: nothing posts once it is closed or GitHub's head
   has moved past the chat's commit (the chat's next turn reviews the new
   head). When it is closed, or a queued turn is cancelled with no other
   turn at work or waiting, every run of this pull request's still in
   progress on the head ends "Not reviewed" (`complete_check_runs`).
4. Show the review in progress: for a working turn, GitHub's head gets a
   run of the App's `in_progress` (external id
   `work-review:<number>:progress:<event>`, the event that made it) unless
   the commit already has a verdict; one left cancelled (a head pushed
   again, a pull request reopened) does not stop a new one. Its title says
   *Waiting to start*, *Preparing the workspace* (the turn is preparing: a
   machine, setup) or *Reviewing*, from the chat's turn state; it is
   rewritten only after reading the run by id, never once completed, and a
   status that arrives after its turn stopped working changes nothing.
   A publication that makes a new run ends "Superseded" every run of this
   pull request's still in progress on its other commits, as GitHub lists
   them for the pull request.
5. Read the diff and the App's reviews on the pull request: a finding is
   posted once a review of the App's carries its marker
   (`<!-- work-review:<commit>:finding:<id> -->`), and a commit holds 30
   findings however they were posted.
6. Post findings the moment they are recorded: every one of the turn's
   first 30 distinct valid findings, as first submitted, that still answers
   the chat's newest request (`current`), on lines the diff has, when the
   commit its turn began on is GitHub's head and no review carries its
   marker. They go in one review whose body is their markers, each comment
   ending with its own, while the commit has room. What a question made
   stale, and what is outside the diff, wait for the review.
7. Hold or tighten the commit's verdict: `action_required`, `success`, then
   `failure`. The verdict so far is the strongest of this App's own "Work
   review" runs on the commit, read from GitHub (another app's alike-named
   run does not count). Every run of this pull request's still in progress
   on the commit takes the verdict the commit holds (another pull request on
   the same head may hold a stronger one), however many a lagging list let
   earlier publications make; when none was in progress, a new run takes a
   verdict that tightens the commit's. A failure stands until the next push,
   a success gives way only to a failure, and no review marks a commit only
   while nothing has. The check's summary says how many findings were not
   posted.
8. Post the review with the turn's first 30 findings no review carries yet,
   as first submitted: inline on lines the diff has, the rest listed in its
   body, their markers with them, while the commit has room. Its body says
   exactly how many more there were: the turn's beyond its first 30, and
   those the commit had no room for. A turn that only answers a question
   adds no review while one of the App's stands for the commit (reviews of
   findings alone do not count), and a passing review is never posted on a
   commit whose verdict is a failure: its findings still are, without it.
   No approval is ever posted.
9. Answer the question: in its thread when it came from an inline comment of
   this pull request, otherwise in the conversation.
10. Record what it did on the chat.

GitHub is the authority on what was posted and what a commit carries; the
chat's metadata is a record of it for people and agents, never trusted for
what to post: the reviewer can write its own chat's metadata, and the pull
request's content can steer it. So a write the record lists is still made
through its stamp (which finds it if it exists), and a chat that refuses the
record (an agent filled its metadata to the limit) fails only the last step,
after everything was posted; the run's error says so. The record sits under
keys that start with `review.`:
`review.verdicts` (a list of `{ commit, verdict }`, each commit's strongest
verdict), `review.posted` (a list of `{ effect, id }`: each write's identity,
`work-review:<turn>:<check|review|reply>` or
`work-review:<commit>:finding:<id>`, and GitHub's id for it), the newest 30
of each, newest last. Which runs are in progress, and which findings are
posted, come from GitHub each time: a finding's publication reads the
pull request even when nothing new came.
Session metadata is bounded (ADR 0226); keep larger records elsewhere.

Every write goes through the `github` connection's typed actions with a
stamp: a check run's external id, or a marker in the body (a finding's
marker is the same wherever it is posted, so its own review, a resubmission
after a restart or hand-off, and the turn's review post it once).
When a write's answer is lost (a timeout, a dropped connection), the
boundary is tried again and the action finds the write GitHub already
accepted by its stamp and returns it instead of posting again. A run in
progress has its words rewritten through its id (`update_check_run`), and
ends with every other run of this pull request's in progress on its commit
(`complete_check_runs`, which ends only the App's own runs whose external
id starts with this pull request's progress prefix). What stays uncertain:
GitHub's lists can lag a write by a moment, so a retry that comes before an
accepted write shows up in them can post it a second time, a review right
behind a finding's publication can post that finding again, and a run made
a moment before the verdict's list can stay in progress until the next
push. No other publication for the pull request writes meanwhile, so the
window is one call's.

The recipe changes nothing it did not write and decides nothing people
own: it does not edit the pull request's description, dismiss earlier
reviews or resolve threads. The review is advice and must not be the sole
merge gate.

## Turn it on and check it

1. Check the workspace with the host's check (the project MCP
   `program_check` tool), then deploy. `bun run --cwd .work check` does
   the same after `bun install --cwd .work`; use matching published versions of
   the `@catamorphic/*` packages.
2. Store `GITHUB_WEBHOOK_SECRET` as a project secret (the server does this
   when it registered the App for this project) and turn on
   `reviewPullRequests`, `answerReviewComments`, `closePullRequestChats` and
   `fillReviewCache` (and, if wanted, `restartStalledReviews`) for the project,
   and `postReviews` for the project in the `github-poster`
   Environment with its `github` connection. Whoever turns them on needs
   `automations:write` (and `caches:write` for `fillReviewCache`) in a role whose `environments` list both
   Environments the workflows run in (`default` and `github-poster`) and
   whose `connections` include
   `{ "environment": "github-poster", "alias": "github" }`. The `github`
   webhook listens once they are on. `restartStalledReviews` also declares
   `sessions:write` and writes `store/reviews/stalls/`: its consent lists
   both, so whoever turns it on needs that permission and a role whose
   `documents` include `{ "path": "store/reviews/stalls/**", "access":
   "write" }` or a wider write, such as the seeded admin's
   `{ "path": "store/**", "access": "write" }`. A plain `"store/**"` entry
   only reads, and the consent is refused.
3. Open a small pull request. Within a minute a chat `pr-<repository>-<number>`
   appears and the "Work review" check shows it in progress; inspect the
   chat: Environment `review`, a review-pool machine, and a workspace at the
   head commit. Each finding appears on the pull request as it is verified;
   when the turn ends, a `postReviews` run posts the review and completes
   the check with its verdict.
4. Push again (same chat, new head), comment `@work why?` (an answer on the
   pull request), then close it (the chat closes; its workspace is gone).
5. Run `fillReviewCache` once by hand, then open the project's caches
   (`GET /projects/:id/environment-caches`): each review machine shows a copy
   with the commit it was filled from. The next review's setup log shows an
   offline install.

When nothing happens, look at the webhook's deliveries (a signature failure
means the secret differs), the workflow's runs (a filtered-out event starts
none), and the chat's placement (no machine in the pool, or one not opened to
the project). A check that stays at *Waiting to start* means no review
machine took the chat yet; at *Preparing the workspace*, its setup is still
running. When the chat reviewed but nothing reached GitHub, open the
`postReviews` run, and the "Work review" check: an `action_required`
run's summary says why a report was unusable (no result, a turn that failed
or was stopped, or a review of another commit), and nothing posts while GitHub's head is past
the chat's commit. A finding's run says why it did not post (stale, outside
the diff, already posted, past the turn's first 30); the turn's review posts
what is left of its first 30.

To see the queue at work, open the pull request chat's runs of
`postReviews`: while one publishes, later ones (a turn's status, a
finding, a settled turn) show as `queued` and start in turn; alike events
join the one waiting. The chat's
`review.verdicts` and `review.posted` say what each commit carries and what
was posted; the pull request's checks say which run shows the review in
progress.
