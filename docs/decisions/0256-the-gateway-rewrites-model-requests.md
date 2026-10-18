# 0256 — The gateway rewrites model requests

- **Status:** Accepted (amends 0180)
- **Date:** 2026-10-18

## Context

The model gateway (ADR 0180) forwards a harness's request body byte for
byte, reading only the model and `stream` for its allowlist and guards.
An aggregator such as OpenRouter routes a request to whichever upstream
provider the body names (`provider.order`, `provider.only`), or any.
Pinning providers in the agent's own configuration does not hold: the
agent, or code in its sandbox, sends what it likes, and the organization's
key serves it. A team that must keep prompts with US providers that retain
no data, or away from some providers altogether, needs the control plane
to decide the routing, whatever the request says.

## Decision

**A model connection's provider may rewrite request bodies.**
`ConnectionModelEndpoint.rewrite(request)` receives the method, the path
below the base URL, the parsed body and the caller (tenant, project,
alias, session), and returns the body to send, or throws
`ConnectionActionRefusedError` to refuse the call. It is host code
(ADR 0183): `defineModelConnectionProvider({ rewrite })`, passed to a
custom server as `hooks.connectionProviders`. Declarative `override`
covers the common case without code: top-level fields set on every
request, each replacing whatever the caller sent, `null` removing one.
The image takes it in `WORK_GATEWAY_CONFIG`'s model entries:
`"override": { "provider": { "only": ["together"], "allow_fallbacks": false } }`.
A provider with both runs its rewrite, then its overrides.

**The rewrite runs first and fails closed.** It sees every request that
carries a body, before the binding's model allowlist and the guards, so
policy judges what the provider will receive. What goes upstream is the
gateway's own serialization of the returned object, with
`content-type: application/json`: no duplicate field or encoding trick a
second parser could read differently. A body that is content-encoded or
is not one JSON object is refused (400) rather than forwarded unrewritten,
and so is a call whose rewrite throws (403). Requests without a body (a
model list) pass unchanged. The gateway parses a body once, and only when
a rewrite, an allowlist or a guard needs it.

Considered: guards that may return a changed input (a guard judges intent
and sees no body; mixing the two would let a guard's order decide what is
sent), a merge patch over the whole body (deep merges keep caller fields
an override meant to replace), and pinning providers with OpenRouter's
own key settings alone (worth doing too, but it lives outside Work and
covers one aggregator).

## Consequences

Provider routing, data-retention flags or usage reporting
(`stream_options.include_usage`) can be imposed per connection, and a
custom server can decide per project or per session. A connection with a
rewrite serves JSON bodies only: uploads in other encodings through it
are refused. Usage and audits record the model the rewritten body names.
