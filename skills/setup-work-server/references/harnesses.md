# Harnesses on the server: Claude Code and Codex

A project agent may be Claude Code or Codex instead of the built-in agent
(ADR 0180). The CLI runs inside the chat's sandbox, on a worker or on the
control plane, and reaches its model through the gateway with the chat's
grant. The model key stays in the control plane's vault; the sandbox holds
only the grant, which stops working when the chat closes.

Members can also run Claude Code and Codex on **their own subscriptions**,
signed in on the machine that runs their chats (ADR 0199): see
[Members' own sign-ins](#members-own-sign-ins) below.

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

A developer can run Claude Code or Codex on **their own subscription** in
their own chats, and bring files the repository never tracks (`.env`,
`apps/api/.env.local`). A sign-in stays on the machine it was made on
(ADR 0199): the member signs in with the CLI's own login on the machine that
runs their chats, into a home for them on that machine's disk. Work never
reads, copies, uploads, stores or forwards it; the machine reports only that
the member is signed in (`sign-in:claude-code:<member id>`).

Why: Anthropic's terms for Claude Code
(<https://code.claude.com/docs/en/legal-and-compliance>, "Authentication and
credential use") let a person sign in to the unmodified Claude Code with
their own subscription on a machine they use, and forbid a service from
collecting, storing, or routing other people's Claude.ai credentials. So
Work never carries one. Codex ChatGPT sign-ins follow the same rule. Whether
a given use is allowed remains the operator's responsibility.

A company that wants Claude Code or Codex for everyone uses keys instead:
a model connection through the gateway (sections 1 to 4 above), or a
member's own API key as their personal connection.

To allow sign-ins, an administrator needs both of these:

1. An Environment that allows them:
   `"environments": { "mine": { "pool": { "owner": "ada" }, "workloads": ["agent"], "personalCredentials": true } }`.
   The implicit `default` Environment does not.
2. Machines the members signed in on. On each one, in a terminal on that
   machine (the member types their own password or approves the device
   code; the operator never sees it):

   ```bash
   docker exec -it work-worker work worker sign-in claude-code --member <member id>
   docker exec -it work-worker work worker sign-in codex --member <member id> -- --device-auth
   work worker sign-ins                                  # who is signed in here
   work worker sign-out claude-code --member <member id> # remove it from this machine
   ```

   Outside the image, `bun apps/server/src/worker.ts sign-in ...` does the
   same. It runs `claude /login` with `CLAUDE_CONFIG_DIR`, or `codex login`
   with `CODEX_HOME`, at `<WORK_DATA_DIR>/sign-ins/<harness>/<member id>`.
   `<member id>` is the member's Work user id (`GET /api/me` as them). A
   running worker reports a new or removed sign-in within seconds; the
   server's own machine does too, for a single person's server.

A chat runs on a member's sign-in only when all of this holds, and every
turn checks it again:

- the machine reports the chat owner's sign-in for that harness (placement
  takes no other machine);
- the machine isolates the member: `WORK_SANDBOX=microsandbox`, a worker
  whose access names only that person (`{ "people": ["ada@example.com"] }`),
  or a local-process machine whose operator sets
  `WORK_PERSONAL_CREDENTIALS=accept` (a single person's server, or
  development);
- the turn is the owner's own message: never a project chat, another
  member's message, an administrator's, or an automation's delivery.

Members then see the agents **Claude Code** and **Codex** (ids
`project:<projectId>:claude-code` and `…:codex`; a role must name them or
`*`). A committed definition can run on the member's sign-in too:
`"credentials": { "source": "personal" }` with `kind` `claude-code` or
`codex`. The CLI runs in the sandbox with its home mounted from the machine
(microsandbox: a read-write bind mount of that one member's home;
local-process: a link to it), so its own token refresh keeps working and
nothing leaves the machine. It talks to the provider directly: no gateway,
no organization key. Cloud sandboxes (Cloudflare, Daytona) refuse sign-ins.
The mounted home holds the CLI's refresh token, which code the agent runs
can read, as on the member's own computer: allow sign-ins only in projects
whose code the member would run on their own machine, and restrict the
Environment's egress (`network.egress: "allowlist"`).

On macOS, Claude Code keeps its login in the Keychain rather than in
`CLAUDE_CONFIG_DIR`: such a sign-in works for local-process chats on that
Mac, not in microsandbox VMs. Sign in on Linux machines for VMs. Codex is
told to keep its sign-in in its home's own file.

Listed files work as before: the member's desktop sends the files named in
the project's `.work/personal/environment.json`
(`{ "files": [".env", "apps/api/.env.local"] }`); the server seals them and
writes them only into that member's own chats, at their repository paths,
listed in `.git/info/exclude`. `GET /api/projects/:id/personal-environment`
(their own token) shows each file's path and size, never a value; `DELETE`
forgets them.

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
