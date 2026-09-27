# Harnesses on the server: Claude Code and Codex

A project agent may be Claude Code or Codex instead of the built-in agent
(ADR 0180). The CLI runs inside the chat's sandbox, on a worker or on the
control plane, and reaches its model through the gateway with the chat's
grant. The model key stays in the control plane's vault; the sandbox holds
only the grant, which stops working when the chat closes.

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
other key variables) only serve the built-in assistant and model guards;
harnesses never receive them.

## 2. Bind it in the Environment

```json
"environments": {
  "build": {
    "pool": { "pool": "build" },
    "workloads": ["agent"],
    "image": ".work/images/harness.Dockerfile",
    "connections": {
      "anthropic": { "provider": "anthropic", "principal": "service", "service": "anthropic",
                     "model": { "allow": ["claude-*"], "maxOutputTokensPerTurn": 200000 } }
    }
  }
}
```

- `model.allow` lists model id patterns the alias serves; absent, any.
- `model.maxOutputTokensPerTurn` refuses further calls in an agent turn once
  that turn's calls produced that many output tokens.
- Guards review every call as connection kind `model` (`"kinds": ["model"]`),
  action `messages`, `count_tokens`, `responses`, `chat.completions`, or
  `models`, with the provider, model, and output limit, never the prompt.

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

## Limits

- Codex in a sandbox runs without Work's capability tools (documents,
  proposals); Claude Code has them.
- A server without a control-plane model (`ANTHROPIC_API_KEY` or
  `WORK_FAKE_AGENT`) still reports chat off.
