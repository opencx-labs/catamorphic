# Review pull requests with Work

Every pull request in a company repository gets a code and security review
from an agent that checks out the change, verifies it by running it, reads
production's shape from a read-only replica, and reports a review with inline
comments and a check run. It is ordinary project code (issue #118, ADRs 0181
and 0259):
the host skill `reviewing-pull-requests` holds every file. This guide is the
server side: GitHub, the service connections, and the review machines.

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
  through the gateway with the session's grant. Its `github` binding only
  reads (and pushes `work/*` branches), so nothing on a review machine can
  write to GitHub: the pull request's own code runs there, and whatever it
  forges in the chat is only a report the poster validates.

## 1. Connect GitHub

Follow [Connect GitHub](connect-github.md): register the App from a manifest
with the project's id (so its webhook points at the project's `github` URL and
its webhook secret becomes the project's `GITHUB_WEBHOOK_SECRET`), install it
on the repository, and attach the repository as the project
(`POST /_work/operator/projects` with `"repository": "acme/web"`). The App
needs, and the manifest requests:

- **Pull requests: write**: reviews and inline comments, replies, resolving
  threads, dismissing its own change requests, the description's summary.
- **Checks: write**: the "Work review" check run.
- **Issues: write**: editing and deleting its own conversation comments.
- **Contents: read**: fetching the change. Reviews need no more; the
  manifest asks for write, which pushes of `work/*` fix branches and the
  project's own sync use.

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

## 3. Enroll review machines

Review machines build the project's image and run Docker inside each
sandbox, so they use microsandbox with an image builder:

1. `POST /_work/operator/workers` with
   `{ "name": "review-1", "labels": { "pool": "review" }, "access": { "projects": ["<project id>"] }, "trusted": true }`.
2. Start the worker with the code, `WORK_SANDBOX=microsandbox`,
   `WORK_IMAGE_BUILDER=docker` (or `podman`), and `WORK_MAX_WORKSPACES` sized
   for concurrent reviews (each runs the change's services). See
   [Machines](cluster-deployment.md#add-a-worker).
3. `GET /_work/operator/machines` shows `worker.review-1` available.

Keep `WORK_CONTROL_PLANE_WORKLOADS=workflow` on the control plane so no agent
runs beside the secrets. The review Environment restricts egress to package
registries; microsandbox enforces it, and the gateway is always reachable.

## 4. Commit the automation

Ask an agent in the project to add the review automation from the
`reviewing-pull-requests` skill, or copy its files:

- `.work/project.json`: the `review` Environment (pool, image, containers,
  egress, `idleReleaseMinutes`, `approvals.waitMinutes`, and the read-only
  `github`, `prod`, and `slack` bindings) and the `github-poster` Environment
  (workflows only; the `github` binding with the poster's typed write
  actions) merged beside the existing `default`.
- `.work/images/review.Dockerfile`: Git, Node, Bun, and Docker on
  `docker:dind`; add the repository's toolchains.
- `.work/triggers/github.ts`: the GitHub trigger library.
- `.work/agents/reviewer.json` and `reviewer.md`: the reviewer and its
  review doctrine.
- `.work/workflows/src/reviews.ts`: `reviewPullRequests`,
  `answerReviewComments`, `closePullRequestChats`, and `postReviews`.

Replace `acme/web` in each trigger's `where` with the project's repository,
so events from the App's other repositories start nothing. Map GitHub logins
to members in `GITHUB_MEMBERS` (they approve the chat's escalations) or
commit a `reviewers` role. Check it with the project MCP `program_check`
tool (`bun run --cwd .work check` needs the `@catamorphic/*` packages, which
are not yet on a public registry), then propose the change; it lands through
a pull request like any other.

## 5. Turn it on

Someone with `automations:write` enables the workflows for the project:
`reviewPullRequests`, `answerReviewComments`, and `closePullRequestChats` in
the `default` Environment, and `postReviews` in `github-poster`, with its
`github` connection consented. The `github` webhook listens once they are on;
`GET /api/projects/:id/webhooks` shows its URL, which the App registered from
a manifest already uses.

## 6. Verify

1. Open a small pull request. A project chat `pr-acme/web-<number>` appears:
   Environment `review`, machine `worker.review-1`, workspace at the pull
   request's head commit. When its turn ends, a `postReviews` run posts the
   review (inline comments), a "Work review" check run, and a summary between
   `<!-- work-review:start -->` and `<!-- work-review:end -->` in the
   description.
2. Push to the branch: the same chat moves to the new head; the next review
   resolves the threads it fixed and, once nothing blocks, dismisses the
   App's earlier change requests.
3. Comment `@work is this migration safe on production?`: the answer arrives
   as a reply.
4. Merge or close it: the chat closes, its sandbox and containers are gone,
   and its session branch and grants are deleted. The transcript stays.
5. The connection audit lists each fetch, query, and GitHub read with its
   session, and each GitHub write with the `postReviews` run; no file on the
   review machine holds a token or password.

If nothing happens: the webhook's deliveries show a `401` when the secret
differs; a draft pull request starts no run until it is ready for review; a
chat that never starts a turn usually has no review machine available to the
project (check the chat's placement and `GET /_work/operator/machines`). A
review that never reaches GitHub shows in `postReviews`' runs: a turn whose
reply has no valid `work-review` block, or one for a commit the chat no
longer stands on, posts nothing but a neutral check run saying so.
