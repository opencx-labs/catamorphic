# Review pull requests with Work

Every pull request in a company repository gets a code and security review
from an agent that checks out the change, verifies it by running it, reads
production's shape from a read-only replica, and reports a review with inline
comments and a check run. It is ordinary project code (issue #118, ADRs 0181
and 0259):
the `pull-request-reviews` pack holds every file. This guide is the
server side: GitHub, the service connections, and the review machines.

For a different review algorithm, cloud allocator or external Postgres ledger,
compose the same primitives rather than requiring a native integration or
forcing this recipe onto the application. See [workflow composition](workflow-composition.md).
The pack's stamped writes and poster do not serialize concurrent publishers;
for overlapping reviews, add a ledger-backed publisher with generation checks
and destination receipts before enabling it unattended.

What runs where:

- The **control plane** receives GitHub's signed webhook, runs the
  workflows, and holds every credential: the App's key, the replica's
  password, Slack's token. It also **posts**: when a review chat's turn ends,
  the `postReviews` workflow (in the workflow-only `github-poster`
  Environment) reads the review the agent reported, checks it, and writes the
  review, the check run, thread replies and resolutions, and the summary in
  the pull request's description.
- A **review machine** (a worker labelled `pool=review`, opened to the
  project) runs each pull request's chat in the `review` Environment: its own
  sandbox from the project's image, with Docker inside it, checked out at the
  pull request's head. It holds no credential; Git and the agent's tools go
  through the gateway with the session's grant. The pull request's own code
  runs there and can use that grant, so the chat's `github` binding only
  reads (no `git:write`) and the reviewer's sandboxing is `contained`:
  nothing on a review machine can write to GitHub, and whatever the code
  forges in the chat is only a report the poster validates.

The review is advice, not a merge gate. The code under review runs where
the review is written, so it can sway the verdict, the "Work review" check,
and the dismissal of earlier change requests on its next commit. Protect
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

- **Pull requests: write**: reviews and inline comments, replies and
  answers in the conversation, resolving threads, dismissing its own change
  requests, the description's summary.
- **Checks: write**: the "Work review" check run.
- **Contents: read**: fetching the change. Reviews need no more; the
  manifest asks for write, which the project's own sync uses.

The manifest also asks for Issues: write. Reviews need it only if you add
automations that edit or delete the App's conversation comments
(`update_issue_comment`, `delete_issue_comment`); the poster does neither.

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
`--host-uds=open`): it offers `containers`, `network.policy` and
`network.setup`. Microsandbox fixes a sandbox's network when it is created,
so it cannot host the `review` Environment ([Setup and
volumes](cluster-deployment.md#setup-and-volumes)).

Reviews come in bursts, so let a machine rule create machines while reviews
wait and destroy them once idle ([Machines on
demand](cluster-deployment.md#machines-on-demand)):

1. Declare a class in `WORK_MACHINES_CONFIG` with `"sandbox": "container"`:
   a `hetzner-cloud` server type (`"review": { "platform": "hetzner-cloud",
   "serverType": "cpx42", "location": "nbg1", "image": "ubuntu-24.04",
   "sandbox": "container" }`) or a `custom` class your server's provisioner
   creates on your cloud. Its machines run the
   [install script](cluster-deployment.md#the-install-script), which
   installs Docker and gVisor and starts the worker on the container
   backend, even where KVM would give microVMs.
2. `PUT /_work/operator/machine-rules/review` with
   `{ "projects": ["<project id>"], "machines": { "demand": { "max": 9 } }, "class": "review", "labels": { "pool": "review" } }`.
   `max` caps concurrent machines; each holds `WORK_MAX_WORKSPACES` reviews.
3. A review that finds no machine waits up to the Environment's
   `waitMinutes`; the rule's status (`GET /_work/operator/machine-rules`)
   counts it as `queued` and shows the machine starting.

For a fixed fleet instead, enroll each machine yourself:
`POST /_work/operator/workers` with
`{ "name": "review-1", "labels": { "pool": "review" }, "access": { "projects": ["<project id>"] } }`,
then start the worker with `WORK_SANDBOX=container` on a Docker daemon with
the `runsc` runtime ([Add a worker](cluster-deployment.md#add-a-worker)).

Keep `WORK_CONTROL_PLANE_WORKLOADS=workflow` on the control plane so no agent
runs beside the secrets. The review Environment's agent reaches only the
gateway; its setup reaches only the registries it lists, while it runs, and
the machine narrows it again by itself if the control plane goes away.

## 4. Commit the automation

Ask an agent in the project to install the `pull-request-reviews` pack:
`registry.read` fetches it, and its docs say what to merge and replace. It
adds:

- `.work/project.json`: the `review` Environment (pool, image, containers,
  gateway-only egress, a `setup` whose network reaches the package
  registries, `waitMinutes`, `idleReleaseMinutes`, `approvals.waitMinutes`,
  and the read-only `github`, `prod`, and `slack` bindings) and the `github-poster` Environment
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
  over ACP on a model connection instead, such as OpenRouter, with
  the providers that may serve the prompts pinned by a rewrite in the
  company's own server image
  ([Harnesses on the server](harnesses.md#pin-what-requests-carry-your-own-server-image)).
- `.work/workflows/src/reviews.ts`: `reviewPullRequests`,
  `answerReviewComments`, `closePullRequestChats`, and `postReviews`.

Replace `acme/web` in each trigger's `where`, and in `REVIEWED_REPOSITORY`,
with the project's repository, so events from the App's other repositories
start nothing. Map GitHub logins
to members in `GITHUB_MEMBERS` (they approve the chat's escalations) or
commit a `reviewers` role. Check it with the project MCP `program_check`
tool (`bun run --cwd .work check` needs the `@catamorphic/*` packages, which
are not yet on a public registry), then propose the change; it lands through
a pull request like any other.

## 5. Turn it on

Someone with `automations:write`, in a role whose `environments` list
`default` and `github-poster` and whose `connections` include
`{ "environment": "github-poster", "alias": "github" }`, enables the
workflows for the project:
`reviewPullRequests`, `answerReviewComments`, and `closePullRequestChats` in
the `default` Environment, and `postReviews` in `github-poster`, with its
`github` connection consented. The `github` webhook listens once they are on;
`GET /api/projects/:id/webhooks` shows its URL, which the App registered from
a manifest already uses.

## 6. Verify

1. Open a small pull request. A project chat `pr-acme/web-<number>` appears:
   Environment `review`, a review machine (created for it when none was
   free), workspace at the pull request's head commit, and its setup's log
   in `.work-session/setup.log`. When its turn ends, a `postReviews` run posts the
   review (inline comments), a "Work review" check run, and a summary between
   `<!-- work-review:start -->` and `<!-- work-review:end -->` in the
   description.
2. Push to the branch: the same chat moves to the new head; the next review
   resolves the threads it fixed and, once the new commit passes, dismisses
   the App's change requests on earlier commits. A commit's check only holds
   or tightens: a failure stands until the next push.
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
rule's `problem` and `failure` in `GET /_work/operator/machine-rules`). A
review that never reaches GitHub shows in `postReviews`' runs: a turn whose
reply has no valid `work-review` block marks the commit `action_required`
with the reason (when no review marked it yet), and a report for a commit
the chat no longer stands on posts nothing at all.
