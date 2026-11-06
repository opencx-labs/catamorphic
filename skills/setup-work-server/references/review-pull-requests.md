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
The pack includes a deployment-owned publisher hook and an application Postgres
ledger. Install both before enabling publication. All publishing replicas share
the ledger and serialize each pull request; stable effect receipts reconcile a
write whose response was lost. An uncertain effect with no confirmed destination
receipt blocks later writes for that pull request rather than guessing it is
safe to repeat a create.

What runs where:

- The **control plane** receives GitHub's signed webhook, runs the
  workflows, and holds every credential: the App's key, the replica's
  password, Slack's token. It also **posts**: when a review chat's turn ends,
  the `postReviews` workflow (in the workflow-only `github-poster`
  Environment) returns one host call with the session and turn ids. The hook
  reads and validates the actual report, checks its current generation and head,
  then posts a commit-bound review, check run and optional reply through the
  connection broker. The default publisher leaves description edits, dismissal
  of earlier change requests and thread resolution to people.
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
the review is written, so it can sway the verdict and the "Work review" check.
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
- **Checks: write**: the "Work review" check run.
- **Contents: read**: fetching the change. Reviews need no more; the
  manifest asks for write, which the project's own sync uses.

The manifest also asks for Issues: write. A pull request conversation can use
pull-request permissions; automations that edit or delete the App's issue
comments need Issues: write. The publisher reads App-owned conversation comments
to reconcile receipts and never edits or deletes them.

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

Replace `acme/web` in each trigger's `where`,
with the project's repository, and use the same repository in the deployment
publisher. Events from the App's other repositories must start nothing. Map GitHub logins
to members in `GITHUB_MEMBERS` (they approve the chat's escalations) or
commit a `reviewers` role. Check it with the project MCP `program_check`
tool (or `bun run --cwd .work check`, with the project's pinned public
`@catamorphic/*` packages installed), then propose the change; it lands through
a pull request like any other.

## 5. Install the publisher in the deployment

Copy the pack's `.work/server/review-publisher.ts`, `review-report.ts` and
`review-publisher.sql` into the company-owned server source. These are templates;
Work never loads privileged code automatically from a project's mutable files.
Apply the SQL to the application Postgres database. Its schema is independent
of Work's tables and is shared by all replicas that publish these reviews.

Use the pack skill's complete deployment manifest: pinned
`@catamorphic/work-server` and `@catamorphic/server-sdk` releases plus `pg`, with
`@types/pg` for typechecking. Keep the telemetry peers too when copying the
reference entry points. Create distinct dedicated `lockPool` and `ledgerPool`
instances pointing to the same database. This keeps lock waiters from starving intent and receipt commits.
Each needs at least one connection; transaction poolers are supported because
coordination uses transaction row locks. Close both pools during deployment
shutdown.

Register `reviewPublicationCapability` under `hooks.capabilityProviders`. It
provides `company.review-publication`, the host call used by `postReviews`.
Configure its actual project and repository, and give it the initialized SDK
through the getter shown in the installed pack skill. The hook resolves the
stamped caller, run and connection authority; the workflow passes ids, never
posting credentials or an unverified report. Follow the pack's tested wiring
example rather than importing these templates from a live project at boot.

## 6. Turn it on

Someone with `automations:write`, in a role whose `environments` list
`default` and `github-poster` and whose `connections` include
`{ "environment": "github-poster", "alias": "github" }`, enables the
workflows for the project:
`reviewPullRequests`, `answerReviewComments`, and `closePullRequestChats` in
the `default` Environment, and `postReviews` in `github-poster`, with its
`github` connection consented. The `github` webhook listens once they are on;
`GET /api/projects/:id/webhooks` shows its URL, which the App registered from
a manifest already uses.

## 7. Verify

1. Open a small pull request. A project chat `pr-acme/web-<number>` appears:
   Environment `review`, a review machine (created for it when none was
   free), workspace at the pull request's head commit, and its setup's log
   in `.work-session/setup.log`. When its turn ends, a `postReviews` run posts the
   commit-bound review with inline comments and a "Work review" check run.
   The description and earlier change requests remain under human control.
2. Push to the branch: the same chat moves to the new head. A stale report
   posts nothing. Each commit's check only holds or tightens, so an overlapping
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
rule's `problem` and `failure` in `GET /_work/operator/machine-rules`). A
review that never reaches GitHub shows in `postReviews`' runs: a turn whose
reply has no valid `work-review` block marks the commit `action_required`
with the reason (when no review marked it yet), and a report for a commit
the chat no longer stands on posts nothing at all.

Model access through the gateway lasts only for the exact review turn attempt
and its live lease (ADR 0293). Background code cannot start model requests with
that turn's old grant after interruption, completion or lease loss, or during a
later turn. Git and HTTP grants keep their normal background lifetime. Calls
already admitted may finish streaming; clean up cloud resources independently
and enforce spending policy in connection guards.
Before unattended use, interleave two publishers and stop one after GitHub has
accepted a create but before its receipt commits. The next attempt must find the
exact App-owned receipt. If it cannot, publication stays blocked while the
operator reconciles the destination; a missing list result is not proof that an
older request cannot still arrive. Stop the old poster and reconcile its writes
before upgrading. This is application policy built from ordinary hooks and
Postgres, not a universal exactly-once external write guarantee.
