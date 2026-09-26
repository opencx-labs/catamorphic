# 0171 — Project-defined trigger kinds and declarative webhook ingress

- **Status:** Accepted
- **Date:** 2026-09-27
- **Refines:** 0039, 0042, 0156

## Context

Only hosts could define trigger kinds (0039), so a project could not say "a
pull request was merged" or "someone mentioned the app in Slack": it received
a raw webhook (0156) and filtered in workflow code, starting a run for every
delivery. The webhook kind itself checked one shape (HMAC-SHA256 over the
body), answered every request 202 and accepted only POST, so Slack's signed
`v0:{timestamp}:{body}`, Stripe's composite header, Standard Webhooks' keys,
GitLab's shared token and every synchronous handshake needed host code.

## Decision

**Every binding may filter, declaratively.** `where` is a reserved key in any
`trigger(kind, config)`: a nested object mirroring the payload whose leaves
are a JSON value (equal), a list of values (one of) or `{ exists }`; header
names match case-insensitively. The parser splits it off before the kind
validates its config, and the host evaluates it on the control plane in the
one fire path every source uses (the project-event dispatcher, schedules,
host `fire`), after the kind's `matches`. It never runs project code.
`Where<Payload>` in `@catamorphic/workflow` types it against the kind's
generated payload.

**Projects define kinds on top of other kinds.** `.work/triggers/*.ts`
exports `defineTrigger({ name, description?, from: trigger(...), where? })`,
read statically like bindings (string-literal name, direct `trigger` call,
constant filter). A workflow binds it by name and may add its own `where`. At
scan the binding resolves through any chain of project kinds to the host kind
that fires it: `trigger_kind` is that kind, `config` is the root `from`
config, and `where_filters` holds every filter along the chain, all of which
must match; `project_kind` keeps the name for display. Cycles, config besides
`where` on a project kind, names a host kind already has, and unknown roots
fail the check and the scan. Definitions are keyed by their position in the
workflow's list, so one workflow may bind several kinds on one webhook, and a
durable delivery fires exactly its activation. Codegen adds each project kind
to `TriggerKinds` with `payload: PayloadOf<typeof import("<module>").<export>>`;
an optional type argument (`Narrow<Base, Patch>` helps) states what the
filtered events carry. Nothing about a project kind exists at runtime beyond
the resolved definition.

**Webhook ingress stays one primitive, configured.** `verify` is a closed
union: `hmac` (algorithm, header, prefix, encoding, a capture `pattern` for
composite headers, a signed-content template over `{body}`, `{timestamp}`
and `{header:<name>}`, a timestamp source with a tolerance window, and base64
or prefixed secrets) and `token` (constant-time comparison of a header or
query value, never stored). `respond` rules answer handshakes with 200 and an
echoed value and store nothing; a rule may carry its own token check in
place of `verify`, which is how GET subscription handshakes are answered.
`maxBodyBytes` raises the 1 MiB default up to the host's maximum
(`webhooks.maxBodyBytes`, `WORK_WEBHOOK_MAX_BYTES`). Bindings of one name
must declare identical settings, so an integration declares its webhook once,
in a project kind. The schemes are pure functions with provider test vectors.

Alternatives: a `payload(event)` mapper in trigger modules (runs project code
on the control plane); per-integration host kinds (GitHub, Slack) in the
framework (integrations are project code); predicates as code (not
introspectable, not typed per binding).

## Consequences

- GitHub, Slack, Stripe, Shopify, Linear, GitLab and Standard Webhooks
  senders are configurations; the skills carry GitHub and Slack libraries.
- Filtered-out events start no runs; the delivery is still recorded.
- The framework `github.*` host kinds remain for desktop session watchers
  until watchers generalize; their names are reserved from project kinds.
  `GithubService.ingestWebhook` (unused) is gone.
- Stored webhook events gain `query`; a token-scheme credential is dropped
  from stored headers and query.
