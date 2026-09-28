# Connect GitHub

GitHub is an ordinary connection on a Work server (ADR 0177). The
organization's authority is a GitHub App installation, connected once as the
`github` service connection. Through it Work attaches company repositories,
syncs what their default branches accept, opens pull requests for members'
proposals, and gives agents and workflows GitHub actions (REST calls, pull
request files, reviews with inline comments, check runs, issue comments)
with tokens minted per call and narrowed to one repository. Nobody pastes a
personal token, and no credential reaches an agent or a sandbox.

## Choose an App

Every Work server gets its **own private App**, owned by the organization
whose repositories it serves and installed only there. Create one for each
person setting up a company brain; never connect the public **Work Desktop** App
(the one the desktop signs people in with) as a server's `github`
connection, and never ask its owners for its key. Two reasons:

- A server acts through installation tokens minted with the App's private
  key. Anyone can install a public App, so its key reaches every
  organization that did; a private App's key reaches only this one.
- An App has one webhook URL. A private App delivers straight to this
  server; a shared one could reach only a single server.

Two ways to get the private App:

- **Register it from a manifest** (below, recommended): the server creates
  it with the right permissions and events, keeps its key in the vault
  without anyone handling it, and points its webhook at a project.
- **Connect a private App the organization already created** (below): its
  App ID, a private key generated for this server, and its installation.
  Generate the key on the App's settings page and hand it only to the
  server; delete keys that are no longer in use.

The App needs these repository permissions: contents (write), pull requests
(write), checks (write), issues (write), metadata (read); and members (read)
on the organization. It subscribes to pull request, pull request review, pull
request review comment, issue comment, check suite, check run, and push
events.

## Register an App from a manifest

GitHub only accepts a manifest from a person's browser. The setup agent
starts the registration on the loopback operator listener; the person
finishes it in their browser on the server's public URL
(`WORK_PUBLIC_URL`), which GitHub returns to.

1. Start the registration (inside the container, as for other operator
   operations):

   ```bash
   docker exec work-brain bun -e '
   const secret = require("fs").readFileSync("/data/operator-secret", "utf8").trim();
   const r = await fetch("http://127.0.0.1:4701/_work/operator/github/app", {
     method: "POST",
     headers: { authorization: "Bearer " + secret, "content-type": "application/json" },
     body: JSON.stringify({ name: "Work Acme", organization: "acme", projectId: "<project id>" }),
   });
   console.log((await r.json()).url);
   '
   ```

   `name` must be unique on GitHub. Leave out `organization` to register
   under the person's own account, and `projectId` to register without a
   webhook. The answer is a one-time link on the public URL, valid for an
   hour; the link itself is the authority, so hand it only to the person
   who will create the App.
2. The person opens the link, confirms the App on GitHub (an organization
   owner, for an organization App), then installs it and chooses
   repositories. With a project, choose that project's repository: the
   App's one webhook feeds this one project (see below).
3. GitHub returns to the server, which stores the App's key in the vault and
   connects the installation as the `github` service connection. With a
   project, the webhook secret is stored as that project's
   `GITHUB_WEBHOOK_SECRET` once the project declares it (the trigger library
   declares it with `use: "webhook"`, so it verifies deliveries and never
   reaches a run); otherwise the page shows it once to set after the library
   lands. The page also shows the App's OAuth client (client ID and secret)
   once, for members' own accounts (see below); Work keeps no copy.

Each step of the link works once, on any replica: the registration is kept
in the database (the App's key sealed in the vault until the installation is
connected), so a replayed or forwarded link finds nothing left to do.

## Use an existing App

Create and authorize the service connection with the operator API (or in
the app as an organization administrator):

1. `POST /_work/operator/service-connections` with
   `{ "name": "github", "providerKind": "github" }`.
2. `POST /_work/operator/service-connections/:id/authorize` returns a form.
3. `POST …/authorize/complete` with
   `{ "authorizationId", "fields": { "appId", "privateKey", "installationId" } }`
   (or `"owner"`, the account the App is installed on, instead of the
   installation ID). The server checks the installation before storing it.

Authorizing again rotates the key. Name a project service connection
`github` for a project whose repositories belong to another App.

## Point the webhook at a project

A project receives GitHub events on its `github` webhook URL, verified with
`GITHUB_WEBHOOK_SECRET` by the GitHub trigger library in the
`writing-workflows` skill (`.work/triggers/github.ts`). After a workflow
binding that library is deployed and enabled, `GET
/api/projects/:projectId/webhooks` shows the URL; set it as the App's webhook
URL with the App's webhook secret, and store that secret as the project
secret the library declares with `use: "webhook"`: the control plane checks
deliveries with it, and no run ever receives it. The desktop needs no
webhook: its watchers poll GitHub with the person's own connection and
record the same events.

An App has one webhook URL, so it feeds one project, and it delivers events
from every repository the App is installed on. Install a webhook App only on
the project's repository, or filter on `repository.full_name` in each
trigger's `where` as the `reviewing-pull-requests` skill does; a workflow
that acts on another repository's event works against the wrong code. Give
each project that needs GitHub events its own App.

## Bind it in project.json

Give an Environment's agents and workflows GitHub through an alias:

```json
"connections": {
  "github": { "provider": "github", "principal": "service", "service": "github",
              "capabilities": ["get", "pull_request_files", "create_review", "issue_comment"] }
}
```

Roles grant the alias. Leave `capabilities` out to keep every action.

## Company repositories

`POST /_work/operator/projects` with `"repository": "owner/name"` attaches a
repository through the `github` service connection (see
[Work server](stock-server.md#github-backed-projects)). The server fetches
what its default branch accepts every minute; Work's own changes arrive as
`work/` branches and pull requests (ADR 0170).

## Members' own accounts

People who want actions attributed to themselves connect their own GitHub
account as a member connection: the desktop signs them in with the App's
device flow. A custom server enables it on the web by passing the App's
OAuth client as `hooks.github.oauth` of `@catamorphic/work-server`.
