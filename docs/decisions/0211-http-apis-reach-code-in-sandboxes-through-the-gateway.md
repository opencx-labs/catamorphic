# 0211 — HTTP APIs reach code in sandboxes through the gateway

- **Status:** Accepted
- **Date:** 2026-10-06
- **Refines:** [0162](0162-connection-gateway-guards-and-sealed-secrets.md), [0175](0175-grants-reach-sandboxes.md), [0205](0205-project-secrets-reach-environments-per-member.md)

## Context

An HTTP API connection (ADR 0162) let agents call an API through connection
tools, JSON in and out. Code the engineer or agent runs in the sandbox (a dev
server, a CLI, an SDK, a test suite) could not use it: only Git (ADR 0175)
and model APIs (ADR 0180) had sandbox routes. A shared organization key, such
as a logging cluster's, had to be pasted into the sandbox as a project secret,
though ADR 0205 says to prefer a gateway connection whenever a value grants
access to a company system.

## Decision

**A generic route beside Git and models.** `<prefix>/gateway/http/<alias>`
and every path below it forward any of GET, HEAD, POST, PUT, PATCH and DELETE
to the connection's base URL, modelled on the model route: the session's
`sandbox` grant authenticates (as a bearer, as the HTTP Basic password with
any user name, or in `x-work-grant`) and is checked before the body is read;
the alias must be bound in the session's Environment (ADR 0172), used by the
chat's agent (its definition's `connections`, as for every alias an agent
reaches) and granted by the member's role, to a connection whose provider
declares `http: { baseUrl, paths?, headers }`; the
path stays below the base URL (no dot segments, including `..;` and
`%2e%2e%3b` forms that servlet containers resolve after dropping path
parameters, and no encoded slashes) and inside
`paths` when set; the binding's capabilities are the methods (`get` also
allows HEAD; a binding without `capabilities` keeps the connection's own); a
contained agent's session sends only methods the provider marks read-only
(ADR 0182). Guards review each request as connection kind = the provider,
action = the lowercase method, input = `{ path, query }` (repeated query
names as lists), never the credential or the body; escalations go to the
session's person as for models and Git, and are refused with no one to ask.
Each request is audited as `connection.http`. The stored key replaces any
authorization the caller sent; hop-by-hop, cookie and identity headers stay
behind both ways; bodies up to 32 MiB travel byte for byte and answers
stream back. Refusals are JSON with a readable message and never a retryable
status. The route is hidden from the API spec.

**Providers.** `defineHttpApiConnectionProvider` offers the route for
connections without named `actions`: named actions fix single operations, so
those connections keep no raw route. `auth` gains `{ basic: true }`: the
stored key is `user:password`, sent as HTTP Basic (ClickHouse's HTTP
interface), for both the connection tools and the route.

**Discovery.** When a sandbox turn (or a person opening the workspace)
prepares the gateway, each HTTP alias gets a sandbox grant in
`.work-session/grants/<alias>`, and `.work-session/env/gateway.sh` (mode
0644, not secret) exports `WORK_HTTP_<ALIAS>` (the alias in
SCREAMING_SNAKE_CASE) as the alias's gateway URL and
`WORK_HTTP_<ALIAS>_GRANT_FILE` as the absolute path of its grant file, as
the sandbox really sees it. Everything that loads `secrets.sh` loads both
files: the agent runner (its attempt names a list of files, and `BASH_ENV`
names the last present), the built-in agent's commands, workspace setup and
terminals. Both files and the grants leave the sandbox when its grants are
revoked with the workspace.

**Grants rotate.** A sandbox grant is issued again at every turn and renewed
every 20 minutes while one runs, with a new bearer each time; the old one is
revoked at once. Code reads the grant file for each request (or again after
a 401) and never keeps a copy; the route accepts only the current grant.
Considered: one grant per session for every alias (a new grant model and a
wider bearer) and a stable bearer extended in place, as MCP grants are (a
leaked copy would live as long as the session).

## Consequences

A team connects a logging cluster or an internal API once; a dev server in a
chat's sandbox queries it with `WORK_HTTP_LOGS` and the grant file, and the
key never enters a sandbox. A grant lives an hour after the last renewal, so
a long-running process between turns loses access until the chat works
again. Clients that hold a password for their lifetime need a small wrapper
that reads the file per request.
