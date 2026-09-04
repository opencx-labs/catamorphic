# 0084: First-release database schema baseline

- **Status:** Accepted
- **Date:** 2026-09-02

## Context

Before the first desktop prerelease, the shared Catamorphic schema accumulated
65 development migrations. They include superseded tables, temporary naming,
and repeated transformations that are useful project history but unnecessary
work and risk for every new PostgreSQL or PGlite installation.

No published Catamorphic release depends on this development migration chain.
The first release is therefore the last clean point at which the install schema
can become a single baseline without creating a compatibility contract for
those intermediate states.

## Decision

Replace the development chain with one schema-agnostic `001_initial.sql` that
describes the current final schema directly. It remains a raw SQL migration,
runs inside the host-selected schema, and must pass against both PostgreSQL and
PGlite. Future schema changes resume as sequential, forward-only migrations
starting at `002`.

The baseline keeps the original `001_initial.sql` filename. A development
database that completed the old chain already records that filename and safely
skips the new baseline while retaining its existing schema and data. Fresh
databases record only the baseline. Partially applied development migration
chains are not a supported upgrade source; they should be reset or restored
from a complete pre-migration backup.

## Consequences

Fresh desktop installs and new embedded hosts execute one migration containing
only the live schema. PGlite startup avoids dozens of obsolete statements, and
the first published migration history starts from the actual release model.

The removed development files remain available in Git history. Existing fully
migrated development databases may retain obsolete rows in `_migrations`, but
those rows are harmless because migration discovery is driven by the packaged
files. Any future squash after a public release would require a separate,
explicit compatibility design rather than repeating this pre-release reset.
