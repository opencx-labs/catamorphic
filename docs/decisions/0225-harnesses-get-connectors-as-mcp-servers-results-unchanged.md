# 0225 — Harnesses get connectors as MCP servers, results unchanged

- **Status:** Accepted
- **Date:** 2026-10-13
- **Amends:** 0065 (the connection MCP gateway), 0133 (profile connectors behind the capability catalog)

## Context

Codex runs a code mode: its newer models see only `exec`, and call every
tool, MCP tools included, from JavaScript in an isolated runtime. It types
each MCP tool's result as `CallToolResult<T>` from the tool's own
`outputSchema`. Claude Code loads MCP tools on demand through tool search
and reads `structuredContent`. A run through Work showed Codex's code mode
working, but losing what makes it worth having:

- `/connection-mcp` wrapped an MCP connection's whole result as JSON text
  inside another result, so code saw two layers of escaped JSON. An
  upstream `isError` read as success, images became base64 text, and tools
  lost their `title` and `outputSchema`.
- Desktop profile connectors reached harnesses only through
  `invoke_capability`, so code called `tools.invoke_capability({name, input})`
  and got a string back: no tool of its own, no declaration, no type.

Agents printed raw results to read them, and code mode cost more tokens
than direct calls.

## Decision

**An MCP connection's tools and results pass through unchanged.** Providers
whose actions are an MCP server's tools say so (`mcp: true`). Their action
definitions carry the tool's `title` and `outputSchema`. `/connection-mcp`
lists them as declared and returns each `CallToolResult` as the server sent
it: content, `structuredContent`, `isError` and `_meta`. Other connections'
actions answer as JSON tool results, with structured content only for
objects. The endpoint speaks the shared stateless MCP handler and
negotiates the protocol revision. On those revisions (≤2025-11-25) an
output schema or structured content that is not an object rides the text
content instead. Workflows still get each action's own result.

**Output types are the tool's, never ours.** Following Codex and Claude
Code, the only declared output type is the MCP server's own `outputSchema`.
Host tools and non-MCP actions declare none, rather than a schema a harness
would type results by and then reject.

**A harness that searches its tools gets each connector as its own MCP
server.** `HarnessCapabilities.toolSearch` says a harness loads MCP tools on
demand (Claude Code, Codex). The desktop mounts each of the agent's profile
connectors for such a harness at
`/desktop/projects/:id/agent-sessions/:id/connectors/:server/mcp`. The
host's pooled client calls the connector, so credentials, elicitation and
the live roster stay where they were. The server key is the one its policy
layers already use, so the runner gates it like any MCP server (ADR 0054)
and "Always allow" lands on the connection. The endpoint never lists or
calls a denied tool, or a write for a contained agent. The address is
stable for the chat, so warm harnesses stay warm (ADR 0222). The
capability catalog leaves mounted connectors out. A harness without tool
search, the built-in agent, keeps them in the catalog.

Rejected:

- Codex dynamic tools per connector. Their results are text, so code gets
  strings and no types.
- Profile connectors as broker `connection_<alias>` bindings. These are
  frozen per allocation and limited to the default Environment. Their
  per-turn grants would cold-start warm harnesses, and their policy layers
  would need rekeying.
- A Work-wide code mode. Harnesses already have one (Codex) or load tools
  on demand (Claude Code), and policy, credentials and audit are Work's
  either way.

## Consequences

Codex code mode calls `tools.<connector>__<tool>(...)` with real
declarations and gets objects and real errors. A server's mid-session
`list_changed` still waits for the pool to reconnect. A harness's own tool
search decides when connector schemas load: a model without search support
loads them up front, as in the harness's own app. Connection results
carrying large media pass through as they are.
