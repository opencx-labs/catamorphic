# 0002 — Embeddable library architecture (server-sdk / fastify-plugin / react)

- **Status:** Accepted
- **Date:** 2026-07-02
- **Updated by:** 0026 (identity-bound `scoped.runs` and one Run surface)

## Context

Catamorphic is embedded inside a host SaaS product so the host's users can build automations. The host owns auth, the user/org model, the database, and deployment. Earlier iterations flirted with a standalone app and a default tenant; both were removed.

## Decision

Catamorphic ships as libraries with three primary developer surfaces:

1. **`@catamorphic/server-sdk`**: the core SDK installed in the host's Node/Bun backend. Its current constructor accepts a database, storage, required host-owned `environmentProvider`, and optional execution/provider integrations; it manages schema-scoped tables through programmatic `catamorphic.migrate()` and exposes request-bound clients through `forTenant({ tenantId }).forUser({ externalUserId, scope? })`. The surface grew beyond the original workflow CRUD to the general-purpose project, document, git, agent, app, workflow, connection, and execution model without changing this in-process embedding decision.
2. **`@catamorphic/fastify-plugin`** — a mountable, encapsulated Fastify plugin (`app.register(catamorphicPlugin, { core, prefix: "/api" })`) exposing the standard HTTP API for frontends, plus a `createApp` factory for sidecar deployments and spec generation. Identity arrives via headers set by the host from its verified auth context.
3. **`@catamorphic/react` + `@catamorphic/ui` + `@catamorphic/registry`** — a layered frontend: headless hooks/atoms for hosts that build their own UI, ready-made opt-in components (canvas, panels, AI bar) for hosts that don't, and a shadcn-style copy-paste registry for hosts that want to own component source. Every out-of-the-box component must be individually opt-out.

Internal packages (`core`, `db`, `git`, `parser`, `sandbox`, `otel`, `runtime`, `plugins`) sit behind these surfaces and remain importable for advanced wiring. Everything is **host-injectable**: DB connections/schemas, storage backends, sandbox providers, LLM credentials, telemetry. No default identity, no default tenant, no standalone boot. A playground demo app (a reference host) is on the roadmap; libraries must never depend on it.

## Consequences

- Hosts integrate at the coupling level they want (DB-only → SDK → HTTP → full UI).
- Every new capability must be designed as "how does a host consume this" first.
- The scoped SDK now exposes identity-bound projects, workflows, files, and
  `scoped.runs` with keyed object parameters. Git, plugins, and secrets remain
  available through core and HTTP surfaces.
- Package renames from this ADR: `@catamorphic/sdk` → `@catamorphic/server-sdk`, `@catamorphic/server` → `@catamorphic/fastify-plugin`.
