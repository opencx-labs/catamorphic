# 0345 — The MCP surface speaks the current protocol; long turns are waited on, not held

- **Status:** Accepted
- **Date:** 2026-11-20
- **Amends:** 0042 (the project MCP endpoint), 0055 and 0161 (what a token may do), 0166 (the member's address), 0225 (which endpoints speak which revisions)

## Context

The project MCP was a hand-rolled, stateless server of the `initialize` era (through 2025-11-25) with tools only. The current revision (2026-07-28) has no handshake or session: every request carries its protocol version and capabilities, servers answer `server/discover`, results carry `resultType`, a server asks its client's person through multi round-trip requests, change notifications arrive on `subscriptions/listen`, and long calls can be tasks (extension `io.modelcontextprotocol/tasks`). Clients differ: Codex stops a tool call after 60 seconds, Claude Code has tasks in beta, others document elicitation only. OAuth scopes were issued and never read.

## Decision

**One dispatcher, both eras, on every endpoint** (`fastify-plugin/src/mcp-server.ts`): the server's, a project's, a project's apps (`/apps-mcp`), and the endpoints that forward a connector's tools (`/connection-mcp`, the desktop's), which pass that server's definitions and results through as before (ADR 0225). A request with the per-request `_meta` or a modern `MCP-Protocol-Version` is served by 2026-07-28: mirrored headers checked (`-32020`), unknown versions named (`-32022`), unknown methods answered 404, `resultType` and caching hints on results, `subscriptions/listen` with an acknowledgement first and keep-alive comments, `tasks/get`, `tasks/update`, `tasks/cancel`. Anything else gets the stateless handshake shell with plain tools. No sessions, no GET stream. We extended our own dispatcher instead of adopting the official SDK's `createMcpHandler`: its subscription bus is in process and does not say who listens to what, so a Postgres-backed feed checked per member does not fit it, and it has no server side for the tasks extension. The official client library tests ours.

**Two endpoints.** `POST /mcp` serves `project_list` and the session operations (ADR 0344) with `project` as an argument: the one address a person gives their agent. `POST /projects/:id/mcp` keeps documents, program and workflows with the same operations bound to the project. Tools are definitions (name, schemas, annotations, scope, handler) in one list.

**A long turn is waited on.** Everything works with plain tool calls that end within 50 seconds: `session_start`, then `session_wait` with the returned cursor; `changed: false` is a timeout. The rest is convenience. A client that declares tasks gets one from `session_wait`: a row of `session_waits`, so its id resolves on every replica and its outcome, written once, never changes; `needs_input` is `input_required` with one form elicitation per request; cancelling stops the watching and never the agent; a failed turn is `completed` with `isError`. A client that declares elicitation and passes `onInput: "ask"` is asked in the same call, with a `requestState` that is an HMAC over the member, the chats, the requests and an expiry. `work://sessions/{id}` and `work://attention` are resources a client reads and listens to.

**Scopes always narrow.** `work:read`, `sessions:run`, `sessions:approve`, `documents:write`, `program:write`, `program:publish`, and `work:full`: the person themself, which Work's own apps ask for and consent shows as one line. Every grant names scopes: an authorization request that names none of Work's is offered the default set (all but `sessions:approve` and `work:full`), ticked, and the person unticks what they withhold. The grant narrows the member's identity where it is built (`withTokenScopes`): roles lose what the scopes withhold, tools a token lacks are not listed, and calling one answers 403 `insufficient_scope`. Core checks by name on every surface, REST included: reading needs `work:read`, starting or changing a chat `sessions:run`, approving `sessions:approve`. REST mutations outside the named scopes and privileged Work routes such as member machine sign-in require `work:full`. A 401 names `work:read sessions:run`. A grant with none of Work's scopes (a sign-in from before this) is refused, so its client signs in again.

## Consequences

- A host with replicas passes the plugin one `mcp.stateSecret`; the Work server derives it from its signing secret.
- `iss` in authorization responses comes from the pinned Better Auth packages. Client ID Metadata Documents need `@better-auth/cimd` and a policy for the fetches it makes; dynamic registration stays meanwhile.
- Each tool declares a compact output schema (under 2 KB, `SESSION_STATE_OUTPUT_SCHEMA`): clients hand it to their model. The whole shape stays in the Zod schema every answer is checked against.
- Unknown tools are a `-32602` error, as the protocol names them.
