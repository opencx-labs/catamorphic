# 0042 — Parameterized trigger kinds (holes) and workflow tools over MCP

## Status

Accepted.

## Context

ADR 0039 laid out almost everything needed for "workflows as AI tools":
per-binding derived IO schemas frozen in `trigger_bindings` (documented
"tool-definition-ready"), `fire({ workflows: [...] })` for "the one tool the
AI called", sync-until-first-wait firing, `canSuspend` guarantees. But the
type system blocked the use case: a kind's payload type is declared once,
per kind, in the host's catalog, and `ValidateTriggers` required
`[Payload] extends [Input]` — so every workflow bound to an "AI Tool Call"
kind would have had to accept one kind-wide payload type. The same wall
exists for any envelope-style kind (an HTTP-request kind whose body varies
per workflow, a queue kind whose message varies per topic).

We rejected two alternatives. A built-in `ai.tool-call` kind special-cases
one use of a general mechanism and leaves the next one (HTTP) stuck. Letting
authors pass explicit schemas at the `trigger()` call site creates a second
source of truth beside the workflow's own input type — drift by
construction, against ADR 0041's projection stance — and TypeScript's lack
of partial type-argument inference makes the call site ugly.

Separately: the only MCP surface (`/projects/:id/apps-mcp`, apps only) can't
expose plain workflows, and the `ai.tool-call` kind existed only as a
fixture.

## Decision

**Trigger kinds are parameterized by typed holes; each bound workflow's own
input (and output) type instantiates them; tool kinds are served per
project over MCP.**

- A kind's payload — or any position inside it — may be a **hole**:
  `payload: hole("Args")` or `payload: z.object({ method: z.string(), body:
  hole("Body") })`. A hole is `z.unknown()` carrying an
  `x-catamorphic-hole: "<Name>"` marker into the kind's JSON Schema;
  codegen renders it as the branded `Hole<"Name">` from
  `@catamorphic/workflow`.
- **The workflow author writes nothing new.** `ValidateTriggers` now
  template-matches instead of whole-payload-matches: fixed template parts
  keep the old direction (host produces them, the input must accept them);
  a hole is defined *by* the input at that position. The payload still
  flows to the run verbatim, so the derived per-binding `input_schema` IS
  the instantiated hole schema — no new extraction, no new tables.
- **Output templates, symmetric.** `defineTriggerKind({ output: ... })`
  declares what the kind demands of the workflow's final step (an HTTP
  response envelope, say), holes included, validated in the mirrored
  direction (workflow produces, template consumes). Kind-level only —
  enforcement is authoring-time types; the runtime stores
  `outputJsonSchema` for introspection.
- **Runtime validation splits cleanly.** Kind-level `validatePayload`
  accepts anything at a hole (it's `z.unknown()`); the per-run input
  validation at `triggerProduction` enforces the workflow's own derived
  schema there. Nothing new fires at fire time.
- **Scan fails closed on empty holes.** A binding whose hole resolves to no
  position in the derived input schema, or to a permissive `{}` (an `any`
  input), fails the commit at scan — `checkProject` applies the same rule
  locally, with the kind catalog's `payloadJsonSchema` now in
  `CheckTriggerKind`. Holes are only supported in plain object-property /
  array-item positions (a single data path must exist); a hole under
  `anyOf`/`allOf`/`additionalProperties`/`prefixItems` is rejected at kind
  registration, before any binding exists. The scan also enforces
  effective MCP tool-name uniqueness (and reserves `catamorphic_poll_run`)
  per project — a `config.name` collision stops the deploy instead of
  bricking the serving roster mid-session.
- **Tool kinds are host declarations, not built-ins.**
  `createCatamorphic({ mcpToolKinds: [mcpToolKind(aiToolCall, (config) =>
  ({ description: config.description, name: config.name }))] })` names
  which kinds are AI-callable and how a binding's constant config projects
  to MCP tool metadata. Core validates every named kind is registered.
- **`POST /projects/:projectId/mcp`** serves one MCP tool per binding of
  every tool kind at the production commit: input schema = the binding's
  frozen schema, metadata from config. The workflow's output schema rides
  `_meta.catamorphic.outputSchema`, deliberately NOT the tool's
  `outputSchema` — MCP clients validate `structuredContent` against an
  advertised output schema, and the detach answer must stay a valid
  result. `tools/call` fires the trigger `mode: "sync"` targeted at that
  one workflow with a 30s budget (half the MCP SDK's default 60s request
  timeout, so a budget-detach answer with its pollable runId always beats
  the client-side abort); a settled run returns its output inline, a
  detached run returns `{runId}` for the shared `catamorphic_poll_run`
  tool. Stateless Streamable-HTTP JSON-RPC sharing one dispatch shell with
  `apps-mcp` (`fastify-plugin/src/mcp-shared.ts`).
- **Coding agents reach the tools over MCP, per session.** Harnesses gain
  `mcpServersForSession(context)` — resolved from the session's project —
  beside the agent-wide `mcpServers`. Claude Code re-resolves it into
  every turn's native config; the ai-sdk harness connects session servers
  fresh per session (closed on dispose, failures never cached), so a
  freshly deployed tool appears on Claude Code's next turn and the
  built-in agent's next chat. The desktop registers `ai.tool-call`
  (payload `hole("Args")`, config `{description, name?}`) and mounts
  `http://127.0.0.1:<port>/api/projects/<id>/mcp` as the `catamorphic`
  server for every chat session, so `mcp__catamorphic__<tool>` calls run
  the project's tool workflows.

## Consequences

- "Expose this workflow as an AI tool" is one line of workflow code:
  `triggers: [trigger("ai.tool-call", { description: "..." })]`. The tool's
  argument schema is the workflow's input type — typed at authoring,
  frozen at deploy, validated per run.
- New generic kinds (HTTP request, queue message) need no core changes:
  define the envelope with holes, optionally an output template, register.
- The type-level template matcher (`PayloadTemplateMatches` /
  `OutputTemplateMatches` in `workflow/src/holes.ts`) is deliberate about
  optionality and direction; union-typed template positions containing
  holes are unsupported (they fail matching, and kind registration rejects
  them) — keep holes in plain object/array positions. Tuple-typed inputs
  demand exact assignability: element-wise matching only applies to plain
  arrays, since the host fires arrays of any length.
- Rich JSON Schema constraints (formats, bounds) can't ride TS types; if
  tool schemas need them later, add a constant-expression *refinement* at
  the binding site that can only narrow the derived schema — derived stays
  the base truth.
- The MCP endpoint inherits the plugin's identity model (host-injected
  headers). Remote/multi-tenant exposure — issued bearer tokens, a
  self-hostable server desktop can connect to, public app/MCP exposure —
  is deliberately out of scope here (see TODO).
