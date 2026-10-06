# 0175: Grants reach sandboxes; credentials never do

- **Status:** Accepted (amended by [0184](0184-personal-credentials-reach-a-members-own-sessions.md): a member's own logins and files may reach sandboxes that run only their work; by [0205](0205-project-secrets-reach-environments-per-member.md): secrets a project lists for an Environment reach its sandboxes; refined by [0211](0211-http-apis-reach-code-in-sandboxes-through-the-gateway.md): HTTP APIs are a third gateway surface, for code in sandboxes)
- **Date:** 2026-09-27
- **Refines:** 0065, 0162, 0164
- **Models implemented by:** [0180](0180-harnesses-run-in-the-sandbox-models-through-the-gateway.md)

## Context

Agents that verify changes need live Git against the company's remotes
(fetch branches, push a fix branch), and teams want their usual harnesses
(Claude Code, Codex) to run on workers. Both run *inside* the sandbox:
`git` and the harness process make their own network calls there. ADR 0162
keeps every upstream credential on the control plane and hands agents only
short-lived grants, but today those grants are used by the model loop on the
control plane (connection MCP servers); nothing in a sandbox holds one.

Three ways to give a sandbox access were considered:

1. **Short-lived upstream tokens in the sandbox** (for example a GitHub App
   installation token, one hour). Simple, but it breaks ADR 0162's invariant:
   sandbox egress is open, so a token can be copied out and used for its full
   lifetime; repository tokens cannot restrict which refs may be pushed;
   revocation is not immediate; every host's token model differs.
2. **An egress proxy with TLS interception** that substitutes credentials.
   Rejected in ADR 0162: it needs interception inside sandboxes and hides
   which system an action touched.
3. **Gateway endpoints authorized by session grants.** The sandbox talks to
   the control plane explicitly; the control plane forwards with the
   credential it holds.

## Decision

Option 3. **Credentials never reach workers or sandboxes; grants may.**

A grant is a bearer bound to one allocation, one session, one connection
alias, and that binding's capabilities. It is only accepted by the gateway,
expires within an hour, is renewed by the control plane while the session
runs, and is revoked when the session is closed, released, or archived with
its workspace. Leaking one exposes, at most, what that session could already
do through the gateway, for minutes, with every use audited.

The gateway gains two protocol surfaces beside connection MCP, both reviewed
by guards (ADR 0162) and audited like any brokered action:

- **Git** (`/gateway/git/:alias/…`): Git smart HTTP (`info/refs`,
  `git-upload-pack`, `git-receive-pack`), streamed. Connection providers
  that can serve Git declare it and hand the gateway HTTP credentials for a
  repository on demand. The binding names the repositories an alias may
  reach and its push rules (for example only `refs/heads/work/*`, never a
  default branch, no deletes or force pushes). The gateway enforces them by
  reading receive-pack's ref commands before forwarding and answers
  denials as ordinary Git errors. At session start the sandbox is configured
  with `url.<gateway>.insteadOf <remote>` and a credential helper that reads
  the current grant, so plain `git clone/fetch/push` works.
- **Models** (`/gateway/model/:alias/…`): a model provider's HTTP API
  (Anthropic Messages, OpenAI Responses and Chat Completions), streamed. The
  organization's model keys become ordinary service connections. Harnesses
  in the sandbox get `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` pointing at
  the gateway and the grant as their key. Usage is recorded per session;
  model allowlists and budgets are guards.

Sandboxes reach the gateway at the control plane's public URL. An
Environment's egress policy can make it the only reachable destination.

## Consequences

Upstream secrets stay in one trust domain while agents use ordinary tools.
Push rules are enforced by Work, not only by the code host, and work the
same on every host. Git and model traffic flows through the control plane,
so large repositories should seed workspaces from a control-plane mirror
(sessions start at a ref without Git traffic) and fetch incrementally.
A grant file exists inside the sandbox; code that can read it can use the
gateway as that session until it expires or is revoked, which is the
session's own authority.

## Implementation notes (Git, 2026-09-27)

- Grants carry a `channel`: `mcp` for the harness's connection MCP servers,
  `sandbox` for the file written into the sandbox, so renewing one never
  revokes the other. Sandbox grants live an hour, are issued at every sandbox
  turn and renewed every 20 minutes while it runs, and are revoked with the
  session's Allocation on close, idle release, and archive.
- MCP grants keep their bearer (#122): harnesses hold it in static
  headers from anchoring, and a review chat may live for days. Each turn
  extends the session's unrevoked MCP grants to an hour before it runs,
  and every 20 minutes while it runs; one that lapsed while the chat idled
  comes back that way. Only grants on an active Allocation extend, so
  close, idle release, and archive still end them for good.
- The plugin mounts `/gateway/git/:alias/*` (under the host's API prefix). The
  grant is the HTTP Basic password (or a bearer); an unauthenticated request
  gets `WWW-Authenticate: Basic` so Git's credential helper answers.
- A connection whose provider serves Git carries `git:read` and `git:write`;
  bindings add `git: { repositories?, push? }` (default: the project's linked
  remote, `work/*`). The gateway reads receive-pack's commands (and a shallow
  client's `shallow` lines) before forwarding, refuses the default branch,
  deletions, refs outside the rules, and pushes without `git:write` as
  report-status `ng` lines Git prints, and audits each fetch and push as
  `connection.git`. Guards see the provider kind, action `fetch` or `push`,
  and `{ repository, refs }`. Force pushes to allowed branches are not
  detected (the gateway does not hold the pushed objects); protect branches
  on the code host where that matters.
- The sandbox's global Git configuration (the sandbox's own `HOME`) includes
  `url.<gateway>/git/<alias>/.insteadOf <remote base>` and a helper that reads
  the current grant file; an empty helper first keeps system keychains out.
- `WORK_GATEWAY_CONFIG` gains a generic `git` entry (base URL; the service
  connection stores a username and password or token) beside providers that
  serve Git natively (GitHub).
