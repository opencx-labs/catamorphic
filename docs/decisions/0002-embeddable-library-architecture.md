# 0002 — Embeddable library architecture (server-sdk / fastify-plugin / react)

- **Status:** Accepted
- **Date:** 2026-07-02

## Context

Catamorphic is embedded inside a host SaaS product so the host's users can build automations. The host owns auth, the user/org model, the database, and deployment. Earlier iterations flirted with a standalone app and a default tenant; both were removed.

## Decision

Catamorphic ships as libraries with three primary developer surfaces:

1. **`@catamorphic/server-sdk`** — the core SDK installed in the host's Node/Bun backend. `createCatamorphic({ database, storage, sandboxProvider?, pluginResolver? })` accepts a Postgres connection string **or a host-owned `pg.Pool`**, manages its own schema-scoped tables (with programmatic `catamorphic.migrate()`), and exposes tenant/user-scoped clients (`forTenant(orgId).forUser(userId)`). It manages projects, workflow CRUD, files, and execution.
2. **`@catamorphic/fastify-plugin`** — a mountable, encapsulated Fastify plugin (`app.register(catamorphicPlugin, { core, prefix: "/api" })`) exposing the standard HTTP API for frontends, plus a `createApp` factory for sidecar deployments and spec generation. Identity arrives via headers set by the host from its verified auth context.
3. **`@catamorphic/react` + `@catamorphic/ui` + `@catamorphic/registry`** — a layered frontend: headless hooks/atoms for hosts that build their own UI, ready-made opt-in components (canvas, panels, AI bar) for hosts that don't, and a shadcn-style copy-paste registry for hosts that want to own component source. Every out-of-the-box component must be individually opt-out.

Internal packages (`core`, `db`, `git`, `parser`, `sandbox`, `otel`, `runtime`, `plugins`) sit behind these surfaces and remain importable for advanced wiring. Everything is **host-injectable**: DB connections/schemas, storage backends, sandbox providers, LLM credentials, telemetry. No default identity, no default tenant, no standalone boot. A playground demo app (a reference host) is on the roadmap; libraries must never depend on it.

## Consequences

- Hosts integrate at the coupling level they want (DB-only → SDK → HTTP → full UI).
- Every new capability must be designed as "how does a host consume this" first.
- The scoped-client surface of server-sdk lags the HTTP surface (runs/git/plugins are `core.*`-only today) and needs to catch up.
- Package renames from this ADR: `@catamorphic/sdk` → `@catamorphic/server-sdk`, `@catamorphic/server` → `@catamorphic/fastify-plugin`.
