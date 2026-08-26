# Database and migrations

First identify the backend from code and deployment rather than asking the
user to name it again.

## Stock layout

- Without `DATABASE_URL`, Catamorphic data uses PGlite under the mounted data
  directory. Stock Better Auth uses a separate `<data>/auth-db` PGlite
  database so its migrations do not alter Catamorphic's long-lived session or
  schema search path.
- With `DATABASE_URL`, Catamorphic uses its dedicated schema and stock Better
  Auth uses `catamorphic_auth` in the same Postgres.
- The data volume also holds signing, operational, and encrypted credential
  material with owner-only permissions. Back up the complete volume, not only
  one database directory.

## Existing hosts

Use the host's pool, connection string, or Kysely/PGlite instance as supported
by `createCatamorphic`. The host owns lifecycle for injected pools and database
instances. Run `catamorphic.migrate()` through the host's normal deployment
process and keep Catamorphic schema-scoped.

## Maintenance checklist

Before a migration, identify the installed version, backend, schema, data
path, backup mechanism, and rollback/recovery procedure. Run the repository's
current migration entrypoint, then verify both Catamorphic and host auth can
read their tables and authenticate a known non-privileged test user.

When a new backend or breaking migration ships, update this reference in the
same change. Do not preserve stale commands for compatibility in a greenfield
release. Read `.agents/skills/database-conventions/SKILL.md` before changing
Catamorphic database code.
