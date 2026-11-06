# 0256 — The gateway rewrites model requests

- **Status:** Accepted (amends 0180; amended by [0261](0261-customize-the-work-server-with-your-own-image.md): requests change only in the server's own code, and the stock gateway file has no `override` or model `paths`)
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

**Host code rewrites request bodies, as guards review actions.**
`hooks.modelRequestRewrites` (`createCatamorphic({ modelRequestRewrites })`
for any host) is a list of `{ name, kinds?, rewrite(request) }`, run in
order on every model connection whose provider kind they name, configured
or built in. `rewrite` receives the method, the path below the base URL,
the query and headers (read-only), the parsed body, and the caller: tenant,
project, alias, provider kind, connection, whose key it is (a service's or
a member's own) and session. It returns the body to send, or throws
`ConnectionActionRefusedError` to refuse. Like a guard it is bounded by the
guard timeout, and a slow, failing or malformed answer refuses the call.

**Connections pin fields and paths as data.** A model provider's
`override` sets top-level body fields on every request, each replacing
whatever was there, `null` removing one; it runs after the host's
rewrites, so it has the last word. `paths` limits the endpoints served by
whole segments (`/chat/completions`, `/models`), keeping an agent off
batch or account endpoints. Both are `defineModelConnectionProvider`
options and `WORK_GATEWAY_CONFIG` model entry fields.

**Order, and failing closed.** Paths, then rewrites and override, then the
binding's model allowlist, then guards: policy judges the body the
provider will receive. What goes upstream is the gateway's own
serialization of the result, with `content-type: application/json`, so no
duplicate field or encoding trick reads differently to a second parser. A
body a rewrite or override governs that is content-encoded, not UTF-8, or
not one JSON object is refused (400); requests without a body pass as
before. The allowlist now also checks every model a body may fall back to
(OpenRouter's `models`), and its `*` stops at `:` and `@`, so `deepseek/*`
reaches no `:online` variant or `@preset`. Every refusal before the guards
is audited as a denied `connection.model` call. The body is parsed once,
and only when a rewrite, an override, an allowlist or a guard needs it.

Considered: a `rewrite` function on the provider itself (a custom server
could not add one to a connection declared in the file or built in without
redeclaring it), guards that return a changed input (a guard judges intent
and never sees the body), and a merge patch over the whole body (deep
merges keep caller fields an override meant to replace).

## Consequences

Provider routing, data-retention flags or usage reporting
(`stream_options.include_usage`) can be imposed per connection, and per
project or session in host code. Rewrites govern the body only: a header
the caller sends passes (a rewrite can refuse on it), a field nested in a
batch request is not top-level, and a JSON number past 2^53 loses
precision in the round trip. For OpenRouter the override that pins routing
is `provider` with `only`, `allow_fallbacks: false` and `data_collection`
or `zdr`, plus `models`, `route`, `preset` and `plugins` set to `null`;
server tools in `tools` (web search) and PDF parsing by a plugin provider
reach third parties outside `provider`, so a host rewrite that strips them,
exact model ids, and `paths` complete it. The server's own model key
(`OPENROUTER_API_KEY`) serves its built-in assistant on the control plane,
outside the gateway: rewrites do not reach it.
