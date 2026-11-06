# Database and migrations

First identify the backend from code and deployment rather than asking the
user to name it again.

## Stock layout

- Without `DATABASE_URL`, Catamorphic data uses PGlite in `<data>/db`. Stock Better Auth uses a separate `<data>/auth-db` PGlite
  database so its migrations do not alter Catamorphic's long-lived session or
  schema search path.
- With `DATABASE_URL`, Catamorphic uses its dedicated schema and stock Better
  Auth uses `catamorphic_auth` in the same Postgres.
- Managed multi-machine deployments require network Postgres. Database access
  alone is insufficient: follow [Managed machines and clusters](cluster-deployment.md)
  for the accepted architecture, current support limits, and readiness evidence.
  Never share a PGlite data directory between server processes.
- The data volume also holds signing, operational, and encrypted credential
  material with owner-only permissions. Back up the complete volume, not only
  one database directory.

## Existing hosts

`createCatamorphic({ database })` accepts `{ pool }` (a host-owned `pg.Pool`),
`{ connectionString }` (a pool Catamorphic owns and closes), or `{ db }` (a
Kysely instance already scoped to Catamorphic's schema; this is how PGlite is
passed, see `apps/server/src/server.ts`). Each takes an optional `schema`
(default `catamorphic`). The host owns the lifecycle of anything it injects.
Run `await catamorphic.migrate()` from the host's normal deploy step or boot;
it is idempotent and touches only Catamorphic's schema.

## Maintenance checklist

Before a migration, identify the installed version, backend, schema, data
path, backup mechanism, and rollback/recovery procedure. The stock server
migrates both databases at boot; a custom host runs `catamorphic.migrate()`.
Then verify both Catamorphic and host auth can
read their tables and authenticate a known non-privileged test user.

When a new backend or breaking migration ships, update this reference in the
same change. Do not preserve stale commands for compatibility in a greenfield
release. Read `.agents/skills/database-conventions/SKILL.md` before changing
Catamorphic database code.
