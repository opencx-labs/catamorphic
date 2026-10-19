---
name: pull-request-reviews
title: Pull request reviews
description: How this project reviews its pull requests: a review chat per pull request on the review pool, its Environments, reviewer and doctrine, and the workflow that posts the review, check run and summary to GitHub. Use when adapting, debugging, or explaining the reviews.
---

# Pull request reviews

This project reviews its pull requests with its own code, installed from the
`pull-request-reviews` pack and the team's to change: the GitHub trigger
library, a `review` Environment with its own image and read-only bindings, a
`github-poster` Environment for workflows only, a `reviewer` agent whose
persona is the review doctrine, and four workflows. With the workflows on,
every non-draft pull request gets a project chat keyed
`pr-<repository>-<number>`:

- **Opened, reopened, ready for review:** the chat starts in the `review`
  Environment on a machine of the review pool, with its workspace checked out
  at `refs/pull/<number>/head`. The agent verifies the change and ends its
  turn with a `work-review` report.
- **The turn ends:** `postReviews` reads the report, checks it, and posts
  the review with inline comments, a "Work review" check run, and a summary
  in the pull request's description, from the control plane. The review is
  advice: the pull request's code ran beside it.
- **A new push:** the same chat moves to the new head (`update: "reset"`) and
  is told what changed, so it reviews the difference; the next report
  resolves the threads it fixed and, once nothing blocks, the poster
  dismisses its earlier change requests.
- **A comment mentioning `@work`:** delivered to the same chat; the report's
  `reply` is posted as the answer.
- **Closed or merged:** `close({ key })` ends the chat: its workspace,
  containers, session branch, and grants are released; the transcript stays.

The review chat never writes to GitHub (ADR 0259). It runs beside the pull
request's own code, which can do anything the chat's grants can, so its
`github` binding only reads (no `git:write`: a push from it would run the
base repository's `on: push` workflows with their secrets) and its
sandboxing is `contained`. Whatever that code forges is a report the poster
validates, never a post. Credentials never reach the review machines either:
the App's key, the replica's password, and Slack's token stay on the control
plane, and Git in the sandbox fetches with the session's grant.

The review is advice, not a merge gate. The pull request's code runs where
the review is written, so it can sway the verdict, the "Work review" check,
and the dismissal of earlier change requests (by reporting that nothing
blocks on its next commit). Protect the base branch with a person's
approval, and if you require the check, require it from the App so a run
another workflow names alike does not count.

The server side (the GitHub App and its webhook, the service connections, the
review machines) is the Work server guide's "Review pull requests with Work";
point whoever runs the server there. `writing-workflows` explains triggers
and `where`, `session-workflows` keyed chats and workspaces.

## .work/project.json

In `review`, `pool` places the chats on machines
enrolled with the label `pool=review` (opened to this project), which a
machine rule can create on demand. The image brings Git, Node, Bun, pnpm,
and Docker; `containers` lets the agent run the change's services with
Docker Compose inside its own sandbox. The agent's sandbox reaches only the
control plane's gateway (`egress: gateway`): GitHub and the other
bindings, and its model.

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
Environment keeps no volumes, so caches belong in the image. `waitMinutes` lets a new review wait for a
machine (one made on demand takes a few minutes) instead of failing.
`idleReleaseMinutes` gives a quiet review's machine back and rehydrates it
on the next push. `approvals.waitMinutes` is how long an escalation waits
for the pull request's people.

The bindings name service connections an administrator set up. In `review`:
`github` (the GitHub App installation; reads, review threads, and Git
fetches), `prod` (a read-only role on a production replica: `query`,
`explain`, `schema`), and `slack` (a user token for `search.messages` and
`conversations.replies`). Leave out what the organization does not have; the
agent treats `prod` and `slack` as optional. `github-poster` runs no
agent and binds the same `github` connection with the typed actions the
poster writes with; none of them is a raw REST write verb, and each one that
changes an existing review, thread, or comment touches only the App's own.

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

## .work/agents/reviewer.md

The review doctrine. Edit it to match the team: what matters in this
codebase, which tests are slow, what never to touch.

## An open model: OpenCode

The `pull-request-reviews-opencode` pack makes the reviewer OpenCode, which
Work runs as an ACP agent in the same sandbox (ADR 0255), on an open-weight
model through OpenRouter or another OpenAI-compatible API. Its image points
OpenCode at `WORK_MODEL_BASE_URL` and `WORK_MODEL_API_KEY`: Work serves the
model connection on the sandbox's loopback for each turn, so no key reaches
the machine. `OPENCODE_DISABLE_PROJECT_CONFIG` keeps the pull request's own
OpenCode settings, `.opencode/` agents and plugins, and `AGENTS.md` out of the
reviewer: the doctrine comes from `reviewer.md` alone. Which providers serve
the prompts, with no fallbacks and no data retention, is the server's: a
rewrite in its own image (the Work server guide's "Harnesses on the server").

## .work/workflows/src/reviews.ts

Every trigger's `where` names the repository this project is attached to,
and so does `REVIEWED_REPOSITORY`. The App's webhook delivers events from every
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

## How reviews reach GitHub

`postReviews` reacts to each settled turn of a review chat (its `where`
selects the `pr-<repository>-` keys). Each step returns one
call and carries the turn to the next with `{ state }`
(`durable-workflows`), and in order it:

1. Reads the turn's reply (`history` through `resultMessageId`) and checks
   its one `work-review` block field by field, with size caps. The
   repository and number come from the chat's key, matched exactly
   (`pr-<repository>-<digits>`), never from the block. Report text is posted
   as the App, so mentions are taken apart (`@name` notifies no one) and
   HTML comments are removed (no fake stamps or summary markers).
2. Checks the chat itself (`inspect`): a project chat, running the
   `reviewer` agent, placed in `review`, started by `reviewPullRequests`.
   Any other chat posts nothing. It compares the block's `reviewedCommit`
   with the commit the chat stands on (`workspace.commit`): a stale report
   posts nothing at all, since the chat has moved and its next turn
   reviews the new head.
3. Keeps inline comments on lines the diff has (`pull_request_files`); a
   comment elsewhere moves into the review's body, since one bad line fails
   the whole review.
4. Posts the review (`COMMENT` or `REQUEST_CHANGES`, never an approval) on
   the chat's commit. A turn that only answers a question adds no review
   when one of the App's already stands for the commit with that verdict or
   requested changes, and leaves the description alone.
5. Reports the "Work review" check run: `failure` for requested changes,
   `success` when nothing blocks, `action_required` when no usable review
   came (a failed turn, an unusable report), with the reason. A commit's
   verdict only holds or tightens: a failure stands until the next push, a
   success gives way only to a failure, and a turn without a review marks a
   commit only while none of the App's runs has.
6. Once the commit passes, dismisses the App's change requests on earlier
   commits.
7. Resolves the threads the report names that the App opened, with their
   replies, and posts the answer to an `@work` question in its thread or
   the conversation.
8. Keeps the summary between `<!-- work-review:start -->` and
   `<!-- work-review:end -->` in the description, leaving the rest as the
   author wrote it.

Every step retries a failed call (`retry`, written out on each step:
the parser reads only an object literal there), and a GitHub read that
fails with a server error throws so its step retries. Each write carries
the hidden stamp `<!-- work-review turn=<turnId> -->` (a check run's
external id `turn=<turnId>`) and passes it as the action's `stamp`: the
action returns what it already posted for that stamp, so neither a retried
step nor a rerun of the turn posts twice.

## Turn it on and check it

1. Check the workspace with the host's check (the project MCP
   `program_check` tool), then deploy. `bun run --cwd .work check` does
   the same where `bun install --cwd .work` can reach the `@catamorphic/*`
   packages, which are not yet on a public registry.
2. Store `GITHUB_WEBHOOK_SECRET` as a project secret (the server does this
   when it registered the App for this project) and turn on
   `reviewPullRequests`, `answerReviewComments`, and `closePullRequestChats`
   for the project, and `postReviews` for the project in the `github-poster`
   Environment with its `github` connection. Whoever turns them on needs
   `automations:write` in a role whose `environments` list both
   Environments the workflows run in (`default` and `github-poster`) and
   whose `connections` include
   `{ "environment": "github-poster", "alias": "github" }`. The `github`
   webhook listens once they are on.
3. Open a small pull request. Within a minute a chat `pr-<repository>-<number>`
   appears; inspect it: Environment `review`, a review-pool machine, and a
   workspace at the head commit. When its turn ends, a `postReviews` run
   posts the review, the "Work review" check run, and the description's
   summary.
4. Push again (same chat, new head), comment `@work why?` (an answer on the
   pull request), then close it (the chat closes; its workspace is gone).

When nothing happens, look at the webhook's deliveries (a signature failure
means the secret differs), the workflow's runs (a filtered-out event starts
none), and the chat's placement (no machine in the pool, or one not opened to
the project). When the chat reviewed but nothing reached GitHub, open the
`postReviews` run, and the "Work review" check: an `action_required`
run's summary says why a report was unusable, and a stale report (the chat
had moved to a newer push) posts nothing.
