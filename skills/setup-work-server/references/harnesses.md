# Harnesses on the server: Claude Code and Codex

A project agent may be Claude Code or Codex instead of the built-in agent
(ADR 0180). The CLI runs inside the chat's sandbox, on a worker or on the
control plane, and reaches its model through the gateway with the chat's
grant. The model key stays in the control plane's vault; the sandbox holds
only the grant, which stops working when the chat closes.

Members can also run Codex on **their own ChatGPT subscriptions**, signed
in from the Work app on a machine of their own (ADRs 0199, 0213): see
[Members' own sign-ins](#members-own-sign-ins) below. Claude Code
subscriptions run only on a member's own computer; on a server, Claude Code
uses a key.

## 1. Connect the model key

`anthropic` and `openai` are built-in connection kinds. An administrator
creates the service connection and enters the key through the form (see
[Service connections and administrators](secrets-and-gateway.md#service-connections-and-administrators)):

1. `POST /_work/operator/service-connections` with
   `{ "name": "anthropic", "providerKind": "anthropic" }`.
2. `POST …/:id/authorize`, then `POST …/authorize/complete` with
   `{ "authorizationId", "fields": { "apiKey": "…" } }`.

For OpenRouter, a self-hosted OpenAI-compatible server, or a provider at
another base URL, declare the kind in `WORK_GATEWAY_CONFIG` first:

```json
{ "type": "model", "kind": "openrouter", "displayName": "OpenRouter",
  "api": "openai", "baseUrl": "https://openrouter.ai/api/v1" }
```

`api` is `anthropic` (Messages, for Claude Code) or `openai` (Responses and
Chat Completions, for Codex). An entry with kind `anthropic` or `openai`
replaces the built-in one. The server's own `ANTHROPIC_API_KEY` (and the
other key variables) only serve the built-in assistant and any guards a
custom server adds; harnesses never receive them.

## 2. Bind it in the Environment

```json
"environments": {
  "build": {
    "pool": { "pool": "build" },
    "workloads": ["agent"],
    "image": ".work/images/harness.Dockerfile",
    "connections": {
      "anthropic": { "provider": "anthropic", "principal": "service", "service": "anthropic",
                     "model": { "allow": ["claude-*"] } }
    }
  }
}
```

- `model.allow` lists model id patterns the alias serves; absent, any. With
  it, every POST must name an allowed model.
- The gateway passes the provider's API through unchanged: any method and
  path below the base URL, the body byte for byte, and the answer streamed
  back. It adds the stored key and drops the caller's key, cookies, and
  hop-by-hop and forwarding headers.
- A custom server's guards review every call as connection kind `model`
  (`kinds: ["model"]`), action the method and path (`POST v1/messages`,
  `GET v1/models`), with the provider, model, and stream, never the prompt.
  Restrict endpoints or spending there, for example by summing `model_usage`.
- Usage is read from each answer as it passes: Anthropic Messages, OpenAI
  Responses, and Chat Completions when the harness asks for
  `stream_options.include_usage`. An answer the gateway cannot read counts
  zero.

## 3. Put the CLI in the image

The harness runs the `claude` or `codex` command it finds on the sandbox's
PATH. Sandboxes need bash, git, `base64`, `tail`, and `mkfifo` besides:

```dockerfile
# .work/images/harness.Dockerfile
FROM node:22-bookworm
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN npm install -g @anthropic-ai/claude-code @openai/codex
```

Microsandbox machines build and boot that image. A local-process worker runs
commands on its own machine, so install the CLIs there (for the Work image,
a derived image `FROM` it that adds them to the PATH). Work runs the harness
through its agent runner, a single file it uploads into the sandbox and runs
with Bun or Node (ADR 0198): the Work image has Bun, and microsandbox
installs Node in an image that has neither.

## 4. Define the agent

`.work/agents/coder.json`:

```json
{
  "version": 1,
  "name": "Coder",
  "kind": "claude-code",
  "model": "claude-sonnet-5",
  "credentials": { "source": "connection", "connection": "anthropic" },
  "environment": { "allowed": ["build"], "preferred": ["build"] }
}
```

`kind` is `claude-code` or `codex`; `credentials.connection` names the
model alias of the agent's Environment (its API must match the harness).
`sandboxing` works as for every agent: the sandbox is the boundary, and core
decides what leaves it (ADR 0182). The harness's own permission mode is a
separate `harnessPermissions` field in its native values:
`{ "permissionMode": "auto" }` for Claude Code (`default`, `acceptEdits`,
`plan`, `auto`, `dontAsk`, `bypassPermissions`; default `acceptEdits`), or
`{ "sandbox": "workspace-write", "approvals": "never" }` for Codex (default
`danger-full-access`, since the Work sandbox is the boundary). Both settings
are in the definition's consent hash. The repository's `CLAUDE.md` and
`.claude/` apply as in the CLI.

## Verify

From a chat with the agent: it edits a file and runs a command; `env` in
the sandbox shows `ANTHROPIC_BASE_URL` (or the Codex provider) pointing at
`<WORK_PUBLIC_URL>/api/gateway/model/<alias>` and no key; the audit lists
`connection.model` calls; after closing the chat, its grant is refused. If an
Environment restricts egress, the gateway's host is always reachable.

## Members' own sign-ins

A developer can run Codex on **their own ChatGPT subscription** in their own
chats, and bring files the repository never tracks (`.env`,
`apps/api/.env.local`). A sign-in stays on the machine it was made on (ADRs
0199, 0213): Codex's own login runs on a machine of the member's own, into a
home for them on that machine's disk. Work never reads, copies, uploads,
stores or forwards it; the machine reports only that the member is signed
in (`sign-in:codex:<member id>`).

**Claude Code subscriptions stay on members' own computers.** Anthropic
suspends accounts it sees used from cloud addresses or shared between
people, and its terms
(<https://code.claude.com/docs/en/legal-and-compliance>, "Authentication and
credential use") frame a subscription as one person on their own machine.
So no server or worker holds a Claude sign-in: `work worker sign-in
claude-code` refuses, and Claude Code on a server runs with a key (sections
1 to 4 above). In the Work app on their own computer, members use their
Claude subscription as they always could.

**One person's account per machine.** OpenAI meters a ChatGPT plan by
account across every surface, and one address signed in to several
people's accounts looks like a shared or resold account however well the
sandboxes are isolated. So a member signs in to Codex only on a machine of
their own:

- a worker whose access names only them (`{ "people": ["ada@example.com"] }`),
  such as one a machine rule creates for every member of a group
  ([cluster deployment](cluster-deployment.md)); or
- a single server's own machine whose operator set
  `WORK_PERSONAL_CREDENTIALS=accept` (a single person's server): the first
  member to sign in there holds it.

A machine never takes a second person's Codex login, from the app or a
terminal. A company that wants Codex for everyone on shared machines uses
keys: a model connection through the gateway, or a member's own API key as
their personal connection.

To allow sign-ins, an administrator needs both of these:

1. An Environment that allows them:
   `"environments": { "mine": { "pool": { "owner": "ada" }, "workloads": ["agent"], "personalCredentials": true } }`.
   The implicit `default` Environment does not.
2. A machine of the member's own, as above.

**Members sign in from the app.** In the Work app, a connected project's
Remote environment lists the member's own machines under Sign-ins. **Sign
in to Codex** makes the machine run `codex login --device-auth` in a fresh
home; the app shows Codex's link and one-time code, and the member enters
the code in their own browser and approves. The token is issued to Codex on
that machine and never leaves it; the code travels sealed to the machine
and back (ADR 0207). A pending, denied, cancelled or expired login never
replaces the member's sign-in, and a machine that restarts forgets pending
logins. **Sign out** deletes the home from that machine.

Device-code sign-in must be on for the member's ChatGPT account (ChatGPT
Settings, Security), and allowed by the workspace administrator on a
business plan; when it is off, Codex refuses and the app shows its words.

An operator can do the same in a terminal on the machine (the member
approves the device code; the operator never sees a token):

```bash
docker exec -it work-worker work worker sign-in codex --member <member id>
work worker sign-ins                               # who is signed in here
work worker sign-out codex --member <member id>    # remove it from this machine
```

Outside the image, `bun apps/server/src/worker.ts sign-in ...` does the
same. It runs `codex login --device-auth` (other login arguments after `--`)
with `CODEX_HOME` at `<WORK_DATA_DIR>/sign-ins/codex/<member id>`, using the
machine's own `codex` or the one the image carries. `<member id>` is the
member's Work user id (`GET /api/me` as them). A running worker reports a
new or removed sign-in within seconds; the server's own machine does too.

A chat runs on a member's sign-in only when all of this holds, and every
turn checks it again:

- the machine reports the chat owner's sign-in (placement takes no other
  machine), and it is the owner's own machine as above;
- the machine isolates the member: a worker whose access names only them, or
  a local-process machine whose operator sets `WORK_PERSONAL_CREDENTIALS=accept`;
- the turn is the owner's own message: never a project chat, another
  member's message, an administrator's, or an automation's delivery.

Members then see the agent **Codex** (id `project:<projectId>:codex`; a role
must name it or `*`). A committed definition can run on the member's
sign-in too: `"credentials": { "source": "personal" }` with `kind` `codex`.
Codex runs in the sandbox with its home mounted from the machine
(microsandbox: a read-write bind mount of that one member's home;
local-process: a link to it), so its own token refresh keeps working and
nothing leaves the machine. It talks to OpenAI directly: no gateway, no
organization key. Cloud sandboxes (Cloudflare, Daytona) refuse sign-ins.
The mounted home holds Codex's refresh token, which code the agent runs can
read, as on the member's own computer: allow sign-ins only in projects
whose code the member would run on their own machine, and restrict the
Environment's egress (`network.egress: "allowlist"`). Codex is told to keep
its sign-in in its home's own file.

Listed files work as before: the member's desktop sends the files named in
the project's `.work/personal/environment.json`
(`{ "files": [".env", "apps/api/.env.local"] }`); the server seals them and
writes them only into that member's own chats, at their repository paths,
listed in `.git/info/exclude`. `GET /api/projects/:id/personal-environment`
(their own token) shows each file's path and size, never a value; `DELETE`
forgets them. Values such as each engineer's own API key belong in project
secrets with a value per member instead, which reach the agent and its shells
as environment variables ([secrets in Environments](secrets-and-gateway.md#secrets-in-environments)).

What the machines need:

- The CLI: on the machine's `PATH` for local-process (the server advertises
  `harness.claude-code` / `harness.codex` when it finds `claude` / `codex`),
  or in the Environment's `image` for microsandbox (see step 3 above).
- Egress to the providers: `api.anthropic.com` (and `claude.ai`,
  `console.anthropic.com` for account checks) for Claude Code;
  `chatgpt.com` and `api.openai.com` (and `auth.openai.com`) for Codex. With
  `network.egress: "allowlist"`, list them.

## Limits

- Codex in a sandbox runs without Work's capability tools (documents,
  proposals); Claude Code has them.
- Model usage on a member's own sign-in comes from the harness's reports,
  not from gateway rows.
