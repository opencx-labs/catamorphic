# 0225 — Harnesses get connectors as MCP servers, results unchanged

- **Status:** Accepted
- **Date:** 2026-10-13
- **Amends:** 0065 (the connection MCP gateway), 0103 and 0133 (connectors behind the capability catalog), 0198 (where a mounted connector's policy is decided)

## Context

Codex runs a code mode: its newer models see only `exec`, and call every
tool, MCP tools included, from JavaScript in an isolated runtime. It types
an MCP tool's results as `CallToolResult<T>` from the tool's own
`outputSchema`. Claude Code loads MCP tools on demand through tool search.
A run through Work showed Codex's code mode working, but losing what makes
it worth having:

- `/connection-mcp` wrapped an MCP connection's whole result as JSON text
  inside another result, so code saw two layers of escaped JSON. An
  upstream `isError` read as success, images became base64 text, and tools
  lost their `title` and `outputSchema`.
- Desktop profile connectors reached harnesses only through
  `invoke_capability`, so code called `tools.invoke_capability({name, input})`
  and got a string back: no tool of its own, no declaration, no type.

## Decision

**An MCP connection's tools and results pass through unchanged.**
- Providers whose actions are an MCP server's tools say so (`mcp: true`).
  Their action definitions carry the tool's `title` and `outputSchema`.
- `/connection-mcp` serves through the same stateless handler as the
  plugin's other MCP endpoints. It lists an MCP connection's tools as
  declared and returns each `CallToolResult` as the server sent it.
- Other connections' actions answer as JSON tool results and declare no
  output schema.
- These protocol revisions (≤2025-11-25) require objects. An output schema
  that is not an object is left out. So is structured content that is not
  an object; it becomes the text when the server sent none.
- Tool `_meta` and `icons` are not forwarded. Workflows still get each
  action's own result.

**Output types are the tool's, never ours.** Following Codex and Claude
Code, the only output type declared is an MCP server's own `outputSchema`.
Host tools declare none. A harness that typed results by an invented schema
would then reject the results that don't match it.

**A harness with tool search gets each connector as its own MCP server.**
- `HarnessCapabilities.toolSearch` marks harnesses that load MCP tools on
  demand: Claude Code and Codex.
- For a host-placed harness with tool search, the desktop serves each of
  the agent's profile connectors at
  `/desktop/projects/:id/agent-sessions/:id/connectors/:server/mcp`. Codex's
  native computer use stays in its own process.
- The host's pooled client calls the connector, so credentials,
  elicitation and the live roster stay in the host. The pool drops a client
  whose call failed.
- The server key is the one the connection's policy layers already use.
  Keys never take a host tool server's name (`workspace`, `catamorphic`).
- The address and a per-chat bearer stay the same for the chat's life, so
  a warm harness keeps them (ADR 0222).
- The endpoint decides every call against the same layers the catalog
  used. A denied tool, or a write for a contained agent, is neither listed
  nor called. An ask waits for the person inside the call, and "Always
  allow" lands on the connection.
- The harness gets no policy for these servers, since its permission mode
  (Claude Code's `bypassPermissions`) could skip it. Calls get a long
  timeout so an ask can wait.
- The capability catalog leaves mounted connectors out. A harness without
  tool search, such as the built-in agent, keeps them in the catalog.

Rejected:
- **Codex dynamic tools per connector.** Their results are text, so code
  gets strings and no types.
- **Profile connectors as broker bindings.** These are frozen per
  allocation and limited to the default Environment. Per-turn grants would
  cold-start warm harnesses.
- **A Work-wide code mode.** Codex has its own, and Claude Code loads tools
  on demand. Policy, credentials and audit are Work's either way.

## Consequences

Codex code mode calls `tools.<connector>__<tool>(...)` with real
declarations, and gets objects and real errors back.

Costs:
- A harness starting a chat lists every mounted connector, connecting each
  through the pool.
- Adding or removing a connector changes a harness's configuration, so its
  next turn starts cold.
- A server's mid-session `list_changed` waits for the pool to reconnect.
- The harness's own tool search decides when schemas load. A model without
  search support loads them up front, as in the harness's own app.
- Mounted calls bypass the capability registry's invocation path. They
  keep the registry's policy layers and approvals, and get their own span.
