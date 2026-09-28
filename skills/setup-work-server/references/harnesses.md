# Harnesses on the server: Claude Code and Codex

A project agent may be Claude Code or Codex instead of the built-in agent
(ADR 0180). The CLI runs inside the chat's sandbox, on a worker or on the
control plane, and reaches its model through the gateway with the chat's
grant. The model key stays in the control plane's vault; the sandbox holds
only the grant, which stops working when the chat closes.

Members can also run Claude Code and Codex on **their own accounts**
(ADR 0184): see [Members' own logins](#members-own-logins) below.

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
a derived image `FROM` it that adds them to the PATH).

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

## Members' own logins

A developer can use their own Claude Code or Codex account in their own
remote chats, and bring files the repository never tracks (`.env`,
`apps/api/.env.local`), without logging in on the server (ADR 0184). Work on
their computer sends the login (with its refresh token removed, so only
their computer ever renews it) and the files listed in the project's
`.work/personal/environment.json`:

```json
{ "logins": ["claude-code", "codex"], "files": [".env", "apps/api/.env.local"] }
```

The server seals them in its vault and delivers them only into that
member's own chats, where all of this holds:

1. The Environment allows it:
   `"environments": { "dev": { "workloads": ["agent"], "personalCredentials": true } }`.
   The implicit `default` Environment does not.
2. The chat is the member's own: never a project chat or an automation's.
3. The machine isolates the member: `WORK_SANDBOX=microsandbox`, a worker
   whose access names only that person (`{ "people": ["ada@example.com"] }`),
   the member's own device, or a local-process machine whose operator sets
   `WORK_PERSONAL_CREDENTIALS=accept` (a single person's server, or
   development).

Members then see the host agents **Claude Code** and **Codex** (ids
`project:<projectId>:claude-code` and `…:codex`; a role must name them or
`*`). A committed definition can use the member's login too:
`"credentials": { "source": "personal" }` with `kind` `claude-code` or
`codex`. The CLI runs in the sandbox with `CLAUDE_CONFIG_DIR` (or
`CODEX_HOME`) at the member's login under `.work-session/home/`, and talks
to the provider directly: no gateway, no organization key. Files land at
their repository paths, listed in `.git/info/exclude`, so nothing commits,
syncs, or pushes them; a path the repository tracks is left alone.

What the machines need:

- The CLI: on the machine's `PATH` for local-process (the server advertises
  `harness.claude-code` / `harness.codex` when it finds `claude` / `codex`),
  or in the Environment's `image` for microsandbox (see step 3 above).
- On a member's own computer (**This machine**, `"device": "member"`), the
  Environment's `image`: the desktop runs chats in microsandbox VMs and
  builds a Dockerfile image when Docker or Podman is installed (the first
  build takes minutes). A chat started there moves to a server Environment
  from the chat's Environment control and continues with its history.
- Egress to the providers: `api.anthropic.com` (and `claude.ai`,
  `console.anthropic.com` for account checks) for Claude Code;
  `chatgpt.com` and `api.openai.com` (and `auth.openai.com`) for Codex. With
  `network.egress: "allowlist"`, list them.

Check a member's state with `GET /api/projects/:id/personal-environment`
(their own token): whether an Environment allows it, each login's
fingerprint, expiry and `needsRefresh`, and each file's path and size, never
a value. `DELETE` forgets everything. When a login expires, the member's
chat says "Your Claude Code login on this server has expired. Open Work on
your computer so it can refresh it."

## Limits

- Codex in a sandbox runs without Work's capability tools (documents,
  proposals); Claude Code has them.
- A server without a control-plane model (`ANTHROPIC_API_KEY` or
  `WORK_FAKE_AGENT`) still reports chat off, members' own logins included.
- Model usage on a member's own login comes from the harness's reports, not
  from gateway rows.
