# 0135: Publish artifact candidates before admitting revisions

- **Status:** Accepted
- **Date:** 2026-09-12
- **Refines:** 0124

## Context

Artifact updates held a database transaction across checkout creation, parsing,
git snapshotting, remote publication, and disposal. Slow storage could occupy a
connection and row lock for the entire operation. Moving publication outside the
transaction while retaining a shared mutable ref would let a losing writer or a
crash change the accepted source.

## Decision

Publish each candidate on a unique immutable ref named
`catamorphic/artifacts/<artifactId>-<candidateId>`. Flat names avoid git
file/directory collisions with existing refs. Build it from the previously accepted
commit and finish remote publication and checkout disposal before opening the
metadata transaction. That short transaction locks the artifact, rechecks its
session and expected revision, and atomically admits the candidate ref and
revision. The database remains the authority for which candidate is visible.

Keep accepted and losing candidates until the existing artifact retention
policy allows collection. Retirement sweeps delete every ref with the artifact's
ref prefix, including candidates published by writers that lost or crashed.
Revisit retired rows in oldest-sweep order so a late publication after an earlier
sweep is eventually collected. Existing running-build and run exclusions apply.
Do not add a second publication journal or compensating shared-ref rewinds.

## Consequences

Storage latency no longer holds artifact metadata locks or database connections.
Readers see only admitted revisions, and stale writers cannot move their source.
Updates can temporarily retain unused candidates; retirement collection owns
those refs and safely repeats without requiring a live writer to compensate.
