# 0180: Harnesses run in the sandbox; models through the gateway

- **Status:** Accepted
- **Date:** 2026-09-27
- **Refines:** 0050, 0057, 0162, 0164, 0174, 0175, 0176

## Context

The Work server ran only its built-in agent, whose model loop runs on the
control plane with the server's own key. Teams that use Claude Code or Codex
wanted the same harnesses for server automations. Those CLIs run their tools
where the process runs and need a model key, and workers hold no
credentials (ADR 0164). ADR 0175 accepted the shape: grants reach sandboxes,
and models are a gateway surface beside Git.

## Decision

**Model keys are connections.** Providers may declare a `model` endpoint:
the API family (`anthropic`: Messages; `openai`: Responses and Chat
Completions), a base URL, and the headers that carry a stored key.
`defineModelConnectionProvider` (server-sdk) builds them; the Work server
offers `anthropic` and `openai` built in, and `WORK_GATEWAY_CONFIG` entries of
type `model` add OpenAI-compatible servers (OpenRouter, self-hosted) or
replace a built-in base URL. An administrator stores the key once as a
service connection with the `model` capability; Environments bind it like any
alias, optionally with `model: { allow: ["claude-*"], maxOutputTokensPerTurn }`.
The server's `ANTHROPIC_API_KEY` and friends remain for the control plane's
own loop and guards only.

**The gateway forwards model APIs.** `/gateway/model/<alias>/…` passes the
provider's HTTP API through, streaming both ways. The session's grant is the
API key (`x-api-key` or `Authorization: Bearer`); the gateway checks it, the
binding's allowlist and turn budget, and the guards (connection kind `model`,
action = endpoint: `messages`, `count_tokens`, `responses`,
`chat.completions`, `models`; input = provider, model, stream, output limit,
never the prompt), then adds the stored key. It reads usage from the answer
or its server-sent events into `model_usage` (migration 035, ADR 0057's token
fields, per session and agent turn) and audits each call as
`connection.model`. Refusals use the calling API's own error shape and never
a retryable status. When a harness reports no usage for a turn, the settled
reply's `metadata.usage` comes from these rows.

**Grants are one mechanism.** At every sandbox turn the control plane issues
the session's `sandbox`-channel grants for its aliases served as protocols
(Git and models), writes each to `.work-session/grants/<alias>`, and renews
them every 20 minutes (ADR 0175). Harnesses read the grant file at each use
(Claude Code through `apiKeyHelper`, Codex through its provider `auth`
command), so renewal needs no restart. Closing, idle release, and archive
revoke them with the Allocation.

**Harnesses run in the session sandbox.** `ClaudeCodeAgent` and `CodexAgent`
take `sandbox: { command? }`. Their control loop stays on the control plane
(topology `controller`: the SDK, tool policy, questions, approvals and the
capability tools); the CLI process runs in the sandbox, with standard input
and output carried over sandbox process operations. ADR 0174's processes gain
`stdin: true` and `writeProcessInput({ data, end? })`, a short operation like
a read (worker queue operation `process.write`), and `spawnInSandbox` in
`@catamorphic/sandbox` presents such a process as a child process. The
Claude Agent SDK's `spawnClaudeCodeProcess` and the Codex app-server client's
injected spawn use it. Standard error goes to a file in the sandbox. Turns
pass `TurnOptions.sandbox` and `TurnOptions.modelGateway` (alias, API, base
URL, grant file); the CLI's environment is exactly the gateway base URL and
harness switches, never the host's. Considered: a streaming transport to
workers (a second channel beside the fenced queue) and a harness supervisor
inside the sandbox (a second protocol). The process operations already carry
everything a stdio protocol needs.

**Agent definitions name the connection.** A committed `claude-code` or
`codex` agent on a server sets `credentials: { source: "connection",
connection: "<alias>" }` and `model`; the alias is added to its connection
requirements. Other credential sources stay desktop concepts, and the desktop
refuses `connection` agents with a clear reason. The harness binaries come
from the Environment's image (ADR 0176).

## Consequences

The acceptance holds end to end: a `claude-code` agent runs on a
local-process worker, edits and runs commands in its sandbox, calls its model
through the gateway, and neither the worker's environment nor its files hold
the key. Every turn costs a process operation per output read and input
write. Claude Code's capability tools travel over its stdio protocol; Codex's
capability listener is on the control plane's loopback, so Codex in a sandbox
runs without Work's capability tools until they travel over the app-server
protocol. Connection MCP servers are reached at the server's public URL with
their `mcp` grants, which are not yet renewed during long sessions. A server
without a control-plane model still reports chat off.
