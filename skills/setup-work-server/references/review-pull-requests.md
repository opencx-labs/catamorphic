# Review pull requests with Work

Every pull request in a company repository gets a code and security review
from an agent that checks out the change, verifies it by running it, reads
production's shape from a read-only replica, and posts a review with inline
comments and a check run. It is ordinary project code (issue #118, ADR 0181):
the host skill `reviewing-pull-requests` holds every file. This guide is the
server side: GitHub, the service connections, and the review machines.

What runs where:

- The **control plane** receives GitHub's signed webhook, runs the three
  workflows (in the project's `default` Environment), and holds every
  credential: the App's key, the replica's password, Slack's token.
- A **review machine** (a worker labelled `pool=review`, opened to the
  project) runs each pull request's chat in the `review` Environment: its own
  sandbox from the project's image, with Docker inside it, checked out at the
  pull request's head. It holds no credential; Git and the agent's tools go
  through the gateway with the session's grant.

## 1. Connect GitHub

Follow [Connect GitHub](connect-github.md): register the App from a manifest
with the project's id (so its webhook points at the project's `github` URL and
its webhook secret becomes the project's `GITHUB_WEBHOOK_SECRET`), install it
on the repository, and attach the repository as the project
(`POST /_work/operator/projects` with `"repository": "acme/web"`). The App
needs checks (write) and pull requests (write), which the manifest requests,
and subscribes to pull request, pull request review comment, and issue
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
  ],
  "guards": [
    { "type": "model", "name": "query-review", "kinds": ["prod-replica"],
      "policy": "Read only what the stated purpose needs. Refuse queries that select email, phone, address, or payment columns.",
      "model": { "provider": "anthropic", "id": "claude-haiku-4-5" } }
  ]
}
```

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
  egress, `idleReleaseMinutes`, `approvals.waitMinutes`, and the `github`,
  `prod`, and `slack` bindings) merged beside the existing `default`.
- `.work/images/review.Dockerfile`: Git, Node, Bun, and Docker on
  `docker:dind`; add the repository's toolchains.
- `.work/triggers/github.ts`: the GitHub trigger library.
- `.work/agents/reviewer.json` and `reviewer.md`: the reviewer and its
  review doctrine.
- `.work/workflows/src/reviews.ts`: `reviewPullRequests`,
  `answerReviewComments`, `closePullRequestChats`.

Replace `acme/web` in each trigger's `where` with the project's repository,
so events from the App's other repositories start nothing. Map GitHub logins
to members in `GITHUB_MEMBERS` (they approve the chat's escalations) or
commit a `reviewers` role. Run `bun run --cwd .work check`, then propose the
change; it lands through a pull request like any other.

## 5. Turn it on

Someone with `automations:write` enables the three workflows for the project.
The `github` webhook listens once they are on; `GET
/api/projects/:id/webhooks` shows its URL, which the App registered from a
manifest already uses.

## 6. Verify

1. Open a small pull request. A project chat `pr-acme/web-<number>` appears:
   Environment `review`, machine `worker.review-1`, workspace at the pull
   request's head commit. The agent's review (inline comments) and a "Work
   review" check run appear on GitHub.
2. Push to the branch: the same chat moves to the new head and updates its
   check run.
3. Comment `@work is this migration safe on production?`: the answer arrives
   as a comment.
4. Merge or close it: the chat closes, its sandbox and containers are gone,
   and its session branch and grants are deleted. The transcript stays.
5. The connection audit lists each fetch, query, and GitHub action with its
   session; no file on the review machine holds a token or password.

If nothing happens: the webhook's deliveries show a `401` when the secret
differs; a draft pull request starts no run until it is ready for review; a
chat that never starts a turn usually has no review machine available to the
project (check the chat's placement and `GET /_work/operator/machines`).
