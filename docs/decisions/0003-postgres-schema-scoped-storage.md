# 0003 — Postgres with schema-scoped tables, host-provided connection

- **Status:** Accepted
- **Date:** 2026-07-02

## Context

As an embedded framework, catamorphic needs persistent state (tenants, projects, runs, plugins, secrets) without polluting the host's database or forcing the host to operate a second database.

## Decision

Catamorphic uses the **host's Postgres** and keeps all of its tables in a **dedicated schema** (default `catamorphic`). The host provides either a `pg.Pool` it owns or a connection string catamorphic manages. Scoping is enforced two ways:

- Connection-string pools get `search_path = "catamorphic"` on every connection.
- Host-provided pools get Kysely's `WithSchemaPlugin`, so every query is schema-qualified regardless of the pool's `search_path`.

Migrations are **forward-only raw SQL** files applied inside the schema (tracked in `<schema>._migrations`), runnable via the `catamorphic-db` CLI or programmatically (`migrateToLatest` / `catamorphic.migrate()`), and always idempotent. Types are generated with kysely-codegen scoped to the schema. Catamorphic never destroys host-owned pools or Kysely instances.

The host may read catamorphic's schema directly for reporting (`JOIN host.orgs.id = catamorphic.projects.tenant_id`); catamorphic never references host tables.

## Consequences

- One database to operate; clean separation via schema.
- Any future stateful need (queues, schedules, sessions) should land in the same schema first — see ADR 0006.
- Cross-schema foreign keys are off the table by design; consistency with host data is the host's concern.
