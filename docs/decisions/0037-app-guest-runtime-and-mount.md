# 0037 — App guest runtime (`@catamorphic/app`) and host mount

- **Status:** Accepted
- **Date:** 2026-07-27
- **Expands:** 0002, 0032, 0036

## Context

ADR 0036 defined how app calls are authorized; something still has to carry
them. The guest bundle needs a typed way to call workflows, and the host needs
a component that renders the bundle without extending trust to it.

## Decision

**`@catamorphic/app`** is the guest-side package, bundled into every app. It is
a postMessage transport plus contract-shaping types; it holds no credentials
and never sees a URL, header, or token.

- `PlainWorkflow<T>` / `DurableWorkflow<T>` shape entries in the project's
  `contracts/` package. Their `input`/`output` pass through `JsonSafe<T>`,
  which resolves non-serializable members (`Date`, `Map`, `Set`, functions,
  `undefined`) to a branded error type naming the offense — every call crosses
  postMessage and JSON over HTTP, and a `Date` that types as `Date` but
  arrives as a string is the exact bug this kills at compile time.
- `createClient<AppContract>()` exposes plain workflows as
  `(input) => Promise<Output>` and durable ones as `{ start } → RunHandle`
  with `poll()` and `result()`. Capability, not kind — consistent with ADR
  0026.
- The protocol is versioned (`catamorphicApp: 1`) and shape-checked on both
  sides; it is a transport, not a trust boundary.

**`AppMount`** in `@catamorphic/ui` renders and brokers:

- The bundle runs in a `srcdoc` iframe, `sandbox="allow-scripts allow-forms
  allow-downloads"`. `allow-same-origin` and `allow-top-navigation` are never
  present, so the guest has an opaque origin — no cookies, no storage, no
  host DOM, no navigation. The document carries a default-deny CSP
  (`default-src 'none'`; only the inline bundle and styles execute); network
  origins from `tenant_app_policies` will extend `connect-src` when plumbed.
- Guest messages are accepted only from the mount's own iframe window, then
  bounded (payload bytes, JSON depth) before any network call — the guest is
  untrusted input, whatever the types claim.
- Valid calls are forwarded to the existing run API with the app-audience
  headers (ADR 0036), so the server re-authorizes every call against the
  version's frozen set. `invoke` polls to the terminal result; `start`
  returns the run id for guest-side polling.
- View state renders as data (`loading | not_found | not_published | ready`)
  with host-replaceable copy, `assertNever`-checked.
- Context is a mount-time snapshot the host re-mounts to change; height is
  guest-reported and clamped.

No new ingress: the only network path is the host page's own API client, which
already carries the host's auth.

## Consequences

A host mounts one component and gets rendering, isolation, and brokering; a
guest imports one package and gets a typed client whose contract cannot drift
from the workflows it calls (same repo, same commit, `satisfies` at the
implementation site).

Every `invoke` is a queued run plus polling — fine for actions, heavy for
chatty dashboards. If that becomes the bottleneck the queue's pickup latency is
the thing to tune, not the authorization path (ADR 0034's analysis applies).

The CSP currently allows no external origins; wiring
`tenant_app_policies.allowed_network_origins` into `connect-src` is follow-up
work, as is streaming run progress to replace polling.
