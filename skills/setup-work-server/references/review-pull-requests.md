# Review pull requests with Work

Every pull request in a company repository gets a code and security review
from an agent that checks out the change, verifies it by running it, reads
production's shape from a read-only replica, and reports a review with inline
comments and a check run. The check shows the review in progress from the
moment it is queued, and each finding is posted as soon as the agent has
verified it. It is ordinary project code (issue #118, ADRs 0181, 0259 and
0337):
the `pull-request-reviews` pack holds every file. This guide is the
server side: GitHub, the service connections, and the review machines.

For a different review algorithm, cloud allocator or external Postgres ledger,
compose the same primitives rather than requiring a native integration or
forcing this recipe onto the application. See [workflow composition](workflow-composition.md).
Nothing installs into the server: publication is the pack's `postReviews`
workflow. It queues per pull request chat (ADR 0325), so overlapping turns,
progress and findings publish one at a time, and a burst of alike events
(an agent's findings) joins the one publication still waiting, so the queue
never fills and the verdict always gets in (ADR 0337). It decides from what
GitHub shows (the chat's metadata
holds a record of each commit's verdict and what it posted, never trusted
for what to post), and writes through the GitHub connection's typed actions
with stamps, so a retry after a lost answer finds the write instead of
posting again.

What runs where:

- The **control plane** receives GitHub's signed webhook (or, on a server
  GitHub cannot reach, polls GitHub with the `github-polling` pack, below),
  runs the workflows, and holds every credential: the App's key, the replica's
  password, Slack's token. It also **posts**, with the `postReviews`
  workflow (in the workflow-only `github-poster` Environment): while a
  review chat's turn is queued, preparing or running, it shows the "Work
  review" check in progress on the head; each `finding` result the reviewer
  submits (with `submit_result`; Work records only a value its schema
  accepts) it validates again and posts at once as an inline comment; when
  the turn ends it reads the turn's typed `review` result, validates it,
  checks the pull request's head, then posts a commit-bound review with the
  findings not posted yet, completes the check run with the verdict, and
  posts an optional reply, through the `github` connection. It leaves description edits, dismissal of earlier
  change requests and thread resolution to people.
- A **review machine** (a worker labelled `pool=review`, opened to the
  project) runs each pull request's chat in the `review` Environment: its own
  sandbox from the project's image, checked out at the pull request's head.
  It holds no credential; Git and the agent's tools go through the gateway
  with the session's grant. The pack's reviewer, the built-in agent, runs on
  the control plane, so its model key and Work's tools never reach the
  machine; its tools run in the sandbox's command container (ADR 0332) with
  the pull request's install scripts, tests and Docker services, which reach
  Git reads through the gateway and nothing else of the chat's. That
  container is the whole sandbox and reserves nothing beside it. A reviewer
  whose harness runs in the sandbox (a project's Claude Code agent) gets a
  second container of its own, holding its grants, model and Work tool
  endpoints, sharing only the checkout; the OpenCode variant runs beside the
  pull request's code, unprotected. The chat's
  `github` binding only reads (no `git:write`) and the reviewer's sandboxing
  is `contained`: nothing on a review machine can write to GitHub, and the
  reviewer's report is only something the poster validates.

The review is advice, not a merge gate. The code under review cannot reach
the reviewer, but what the pull request wrote still reaches it as content
and can sway the verdict and the "Work review" check.
Protect
the base branch with a person's approval (branch protection or rulesets),
and if you also require the "Work review" check, pick the App as its
expected source so a run another workflow names alike does not count.

## 1. Connect GitHub

Follow [Connect GitHub](connect-github.md): register the App from a manifest
with the project's id (so its webhook points at the project's `github` URL and
its webhook secret becomes the project's `GITHUB_WEBHOOK_SECRET`), install it
on the repository, and attach the repository as the project
(`POST /_work/operator/projects` with `"repository": "acme/web"`). The App
needs, and the manifest requests:

- **Pull requests: write**: reviews and inline comments, and replies to
  review comments.
- **Checks: write**: the "Work review" check run, in progress and then
  completed.
- **Contents: read**: fetching the change. Reviews need no more; the
  manifest asks for write, which the project's own sync uses.

The manifest also asks for Issues: write. A pull request conversation can use
pull-request permissions; automations that edit or delete the App's issue
comments need Issues: write. The poster finds its own conversation comments by
their stamp on a retry and never edits or deletes them.

It subscribes to pull request, pull request review comment, and issue
comment events.

The App's one webhook feeds this one project, with events from every
repository the App is installed on. Install it only on this repository;
the workflows also ignore other repositories' events (step 4).

With an existing App, connect it as the `github` service connection, point
its webhook at the URL from `GET /api/projects/:id/webhooks` once the
workflows are on (step 5), and store its webhook secret as the project secret
`GITHUB_WEBHOOK_SECRET`.

## 2. Connect the replica and Slack

Declare them in the gateway file (`WORK_GATEWAY_CONFIG`, see [Secrets and the
gateway](secrets-and-gateway.md)):

```json
{
  "connections": [
    { "type": "postgres", "kind": "prod-replica", "displayName": "Production (replica)" },
    { "type": "http", "kind": "slack", "displayName": "Slack", "baseUrl": "https://slack.com/api",
      "actions": [
        { "name": "conversations.replies", "method": "get", "path": "/conversations.replies" },
        { "name": "search.messages", "method": "get", "path": "/search.messages" }
      ] }
  ]
}
```

To review each query before it runs (refusing queries that select email,
phone, address, or payment columns), add guards in a custom server
([Guards are host code](secrets-and-gateway.md#guards-are-host-code)).

Then create and authorize the service connections the review Environment
names (operator routes, or the app as an organization administrator):

- `prod-replica`: a read-only role on a replica, ideally over views without
  personal data (`CREATE ROLE work_reader LOGIN PASSWORD '…'`, then
  `GRANT USAGE` and `GRANT SELECT` on the schema it may read). The gateway
  refuses roles that can write when the connection string is entered.
- `slack-search`: a Slack user token with `search:read` and the history
  scopes, from an account meant for it ([Connect Slack](connect-slack.md)).

Both are optional: the reviewer works without them and says what it could
not check.

## 3. Review machines

Review machines build the project's image, run Docker inside each sandbox,
and give setup its own network while the agent reaches only the gateway, so
they run the container backend under gVisor (`runsc` with `--net-raw` and
`--host-uds=open`): it offers `containers`, `network.policy`,
`network.setup`, `commands.separate`, which runs the reviewer's commands
apart from it (the machine serves each sandbox's command socket over the
same host sockets), and `caches`. Microsandbox fixes a sandbox's network
when it is created and runs no command container, so it cannot host the
`review` Environment ([Setup and
volumes](cluster-deployment.md#setup-and-volumes)); nor can a machine
running privileged runc containers. The container backend mounts the
`review` Environment's pnpm cache read only into the command container
(`caches`, ADR 0334), filled from `main` by the pack's `fillReviewCache`:
each machine keeps its own copy. Keep warm machines in the plan when
you want the cache ready before a review arrives.

For dedicated machines, use `onePerChatKey` from `machines-policies` with
one checkout per open pull request, label the workers `pool=review`, and
scope them to the project's review chat keys. A shared pool can use
`onDemand` with a maximum and the project's principal. Choose an idle policy
that stops the machines to preserve their disk, or destroys them after
draining. Use `machines-ec2` or `machines-hetzner` for the platform verbs
and `machines-install` with `sandbox: "container"` for the worker image.
See [the machine plan](cluster-deployment.md#a-machine-plan).

A waiting review inherits the server wait on a server with `hooks.machines`;
`waitMinutes` sets the project's own bound. Watch worker state and errors in
the machine listing. Plan enough disk for the installed checkout, Docker
data, and the pack's 16 GiB cache fill. A worker under its floor offers no
new workspace and its project can observe `machine.disk-low`.

For a fixed pool, enroll with
`{ "name": "review-1", "labels": { "pool": "review" }, "for": [{ "project": "<project id>" }] }`
and run the worker with `WORK_SANDBOX=container` on a Docker daemon with
`runsc` ([Add a worker](cluster-deployment.md#add-a-worker)).

Keep `WORK_CONTROL_PLANE_WORKLOADS=workflow` on the control plane so no agent
runs beside the secrets. The review Environment's agent reaches only the
gateway; its setup reaches only the registries it lists, while it runs, and
the machine narrows it again by itself if the control plane goes away.

## 4. Commit the automation

Ask an agent in the project to install the `pull-request-reviews` pack:
`registry.read` fetches it, and its docs say what to merge and replace. It
adds:

- `.work/project.json`: the `review` Environment (pool, image, containers,
  gateway-only egress, `commands` apart from the reviewer with only the
  `git` binding (Git reads of the repository), a `setup` whose network reaches the package
  registries, `waitMinutes`, `idleReleaseMinutes`, `approvals.waitMinutes`,
  and the read-only `github`, `git`, `prod`, and `slack` bindings) and the `github-poster` Environment
  (workflows only; the `github` binding with the poster's typed write
  actions) merged beside the existing `default`. Fix branches are left out:
  `git:write` in `review` would let the pull request's code push with the
  chat's grant, and App pushes run the base repository's `on: push`
  workflows with its secrets. A team that wants fixes pushed gives that to a
  separate chat that never runs the pull request's code.
- `.work/images/review.Dockerfile`: Git, Node, Bun, and Docker on
  `docker:dind`; add the repository's toolchains.
- `.work/triggers/github.ts`: the GitHub trigger library.
- `.work/agents/reviewer.json` and `reviewer.md`: the reviewer and its
  review doctrine. The `pull-request-reviews-opencode` pack runs OpenCode
  over ACP on a model connection instead (beside the pull request's code:
  OpenCode loads plugins from the checkout, so Work does not run it apart
  and its reviews are not protected from the code they review; its
  `effort`, if set, chosen
  among the model's variants; a chat whose sandbox was replaced continues
  from a hand-off that keeps its submitted reviews and the pushes and
  comments they do not answer yet, ADR 0328), such as OpenRouter, with
  the providers that may serve the prompts pinned by a rewrite in the
  company's own server image
  ([Harnesses on the server](harnesses.md#pin-what-requests-carry-your-own-server-image)).
- `.work/workflows/src/reviews.ts`: `reviewPullRequests`,
  `answerReviewComments`, `closePullRequestChats`, and `postReviews`.
- `.work/workflows/src/stalled-reviews.ts`: the optional
  `restartStalledReviews`. The reviewer's `stall` (20 minutes) makes Work
  emit `session.turn-stalled` when a review turn stops making progress (a
  hung tool call, a stuck harness, ADR 0333); this workflow keeps Work's
  record of the attempt (its runner's and harness's own output, masked) in
  the project store, restarts the turn, and after two restarts stops it, so the
  commit's check says the review did not finish.

Replace `acme/web` in each trigger's `where` and in `REVIEWED_REPOSITORY`
with the project's repository. Events from the App's other repositories must start nothing. Map GitHub logins
to members in `GITHUB_MEMBERS` (they approve the chat's escalations) or
commit a `reviewers` role. Check it with the project MCP `program_check`
tool (or `bun run --cwd .work check`, with the project's pinned public
`@catamorphic/*` packages installed), then propose the change; it lands through
a pull request like any other.

## 5. Turn it on

Someone with `automations:write`, in a role whose `environments` list
`default` and `github-poster` and whose `connections` include
`{ "environment": "github-poster", "alias": "github" }`, enables the
workflows for the project:
`reviewPullRequests`, `answerReviewComments`, and `closePullRequestChats` in
the `default` Environment, and `postReviews` in `github-poster`, with its
`github` connection consented. Turn `restartStalledReviews` on for the
project in `default` too to restart hung reviews. It declares
`sessions:write` and writes `store/reviews/stalls/` (ADR 0335): the consent
lists both, and the person needs that permission and a role whose
`documents` include `{ "path": "store/reviews/stalls/**", "access": "write" }`
or a wider write, such as the admin role's
`{ "path": "store/**", "access": "write" }` ([First brain](first-brain.md)).
A plain `"store/**"` entry only reads, and the consent is refused. Its runs reach
no other store path. The `github` webhook listens once they are on;
`GET /api/projects/:id/webhooks` shows its URL, which the App registered from
a manifest already uses.

**A private server.** When GitHub cannot reach the server, install the
`github-polling` pack beside this one and turn `pollGithub` on for the
project in its `github-poller` Environment. Its consent lists `events:write`
and its cursor folder, `store/github-polling/` (write): the person needs the
permission and a role whose `documents` include
`{ "path": "store/github-polling/**", "access": "write" }` or a wider write. It polls
the repository every minute and records the same pull request and comment
events the webhook would deliver (ADR 0326), so the review workflows above
run unchanged; skip the webhook URL and `GITHUB_WEBHOOK_SECRET`. Events
arrive up to a minute late, and the first poll records nothing: it remembers
the open pull requests as they are.

## 6. Verify

1. Open a small pull request. A project chat `pr-acme/web-<number>` appears:
   Environment `review`, a review machine (created for it when none was
   free), workspace at the pull request's head commit, and its setup's log
   in `.work-session/setup.log`. Within a minute the "Work review" check is in
   progress (*Waiting to start*, *Preparing the workspace*, *Reviewing*), and
   each finding appears as an inline comment as it is verified. When its turn
   ends, a `postReviews` run posts the commit-bound review and completes the
   check run with its verdict. The description and earlier change requests
   remain under human control.
2. Push to the branch: the same chat moves to the new head, and the earlier
   head's check, if still in progress, is cancelled. Nothing posts for a head
   the chat has not reached yet, and nothing more for one it left. Each commit's check only holds or tightens, so an overlapping
   passing report cannot replace a failure on that commit.
3. Comment `@work is this migration safe on production?`: the answer arrives
   as a reply, with no new review when nothing else changed.
4. Merge or close it: the chat closes, its sandbox and containers are gone,
   and its session branch and grants are deleted. The transcript stays.
5. The connection audit lists each fetch, query, and GitHub read with its
   session, and each GitHub write with the `postReviews` run; no file on the
   review machine holds a token or password.

If nothing happens: the webhook's deliveries show a `401` when the secret
differs; a draft pull request starts no run until it is ready for review; a
chat that never starts a turn usually has no review machine available to the
project (check the chat's placement, `GET /_work/operator/machines`, and the
latest plan result in `GET /_work/operator/workers`). A
review that never reaches GitHub shows in `postReviews`' runs: a turn that
submitted no `review` result marks the commit `action_required`
with the reason (when no review marked it yet), and so does a review whose
named commit, or the commit its turn began on, is not the head. Nothing posts
while GitHub's head is past the chat's commit. A check that stays at *Waiting
to start* has no review machine yet; one at *Preparing the workspace* is in
setup. A finding's run says why it did not post (a later request made it
stale, it is outside the diff, it was already posted, it is past the turn's
first 30); the turn's review posts what is left of its first 30.

Model access through the gateway lasts only for the exact review turn attempt
and its live lease (ADR 0293). Background code cannot start model requests with
that turn's old grant after interruption, completion or lease loss, or during a
later turn. Git and HTTP grants keep their normal background lifetime. Calls
already admitted may finish streaming; clean up cloud resources independently
and enforce spending policy in connection guards.
While one `postReviews` run publishes, later runs for the same pull request
(a turn's status, a finding, a settled turn) show as `queued` and start in
turn, alike events joining the one waiting; the chat's `review.verdicts` and `review.posted`
metadata say what each commit carries and what was posted, and the pull
request's checks which run shows the review in progress. A stamp finds a write GitHub accepted when its answer
was lost, and a finding's marker finds it wherever it was posted; a write
GitHub's lists do not show yet can still be posted twice by one retry or
the publication right behind it. This is application policy built from ordinary workflow primitives, not
a universal exactly-once external write guarantee. A deployment that ran the
earlier server publisher removes its hook registration and its
`work_review_publication` schema once its last runs have finished.
