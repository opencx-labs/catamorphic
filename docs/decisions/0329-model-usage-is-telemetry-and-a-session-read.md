# 0329: Model usage is telemetry and a session read

- **Status:** Accepted (amends 0180 and 0293)
- **Date:** 2026-11-17

## Context

The model gateway (ADR 0180) reads every answer's token usage and writes a
`model_usage` row per call, but its span carried only the alias and path.
A host exporting OpenTelemetry could not add up a review's tokens, and the
provider's charge was discarded: OpenRouter reports what it billed in each
answer's `usage.cost`. Nothing summed a chat and its subsessions. Spend limits
stay project or host policy (guards are host code, ADRs 0162 and 0183); Work's
part is the data they need.

## Decision

**Spans carry usage.** `gateway.model` gains the call's correlation
(`catamorphic.tenant.id`, `catamorphic.project.id`,
`catamorphic.agent.session.id`, `gen_ai.conversation.id`,
`catamorphic.agent.turn.id`), `catamorphic.agent.id` when the session has one,
and `gen_ai.request.model` when the request names it. It still ends when the
answer's headers are sent. Each forwarded call gets a child `chat <model>`
client span from forwarding until its answer ends, so a streamed answer's
usage lands on it. It carries the GenAI conventions the built-in harness uses
(ADR 0119): `gen_ai.operation.name`, `gen_ai.provider.name` (the connection's
provider kind), `gen_ai.request.model`, `gen_ai.response.model`,
`gen_ai.usage.input_tokens` (all input, cached included, as the convention
says), `gen_ai.usage.output_tokens`, `gen_ai.usage.cache_read.input_tokens`,
`gen_ai.usage.cache_write.input_tokens`,
`gen_ai.usage.reasoning.output_tokens`, plus `http.response.status_code`,
`catamorphic.model.cost_usd` when reported and
`catamorphic.model.interrupted` when the caller stopped reading.

**Cost is what the provider reported.** `model_usage.cost_usd numeric` is
null unless the answer's usage carried a finite, non-negative `cost`
(OpenRouter's, in US dollars; a streamed answer's final usage chunk). Work
keeps no price table and never estimates. A turn's gateway usage carries
`costUsd` only when every one of its calls reported one.

**One read for totals.** `usage({ sessionId | key, family? })`, a session
operation for workflows (`host["catamorphic.sessions"].usage`) and
`GET /projects/:projectId/agent/sessions/:sessionId/usage?family=true`,
answers the settled calls of a chat, or of the chat and every subsession
below it, grouped by model: calls, token totals, the summed reported cost,
how many calls reported none (so a reader knows the cost is a lower bound),
and calls still streaming. Reading the chat is the access check. Session
inspect stays as it is: its hot path gains no aggregate.

**Provider refusals are classified, not rewritten.** The provider's own error
still travels unchanged. The `chat` span records an upstream 401 as
`error.type` `provider.authentication`, 402 as `provider.billing`, 403 as
`provider.permission` and 429 as `provider.rate_limit`, and the audit entry
records the same kind, so a host can alert on them. Making them the turn's
cause is the harnesses' part (ADR 0298): Claude Code and Codex already
classify 401 and 429; nothing classifies 402; the ACP adapter emits no
`provider.retrying`, so an ACP agent that retries a refusal itself looks
busy. Those are follow-ups in the adapters, not gateway state.

Alternatives: a cost estimate from a price table (decided against; a stale
price is worse than a known gap); usage only on `gateway.model` ended at
stream end (it would change what that span has measured since 0180); a
summary on inspect (a grouped scan on every inspect).

## Consequences

Hosts sum tokens and reported cost per project, chat, turn or agent from
traces alone; projects build limits and reports on the read. Calls to
providers that report no cost count as unpriced. No limits, budgets or
quotas are added.
