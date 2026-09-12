# 0128: Durable manual development data

- **Status:** Accepted
- **Date:** 2026-09-11

## Context

A manual desktop profile in the operating system's temporary directory lost
PostgreSQL catalog files while running. A session send then failed before its
agent started. Manual development profiles contain real projects and credentials.

## Decision

Keep worktree-isolated manual desktop and stock-server profiles under
`~/.catamorphic/dev/<worktree-instance>`. Retain the existing worktree hash, port
allocator and instance locks. Only disposable tests and coordination files use
temporary storage. On first launch, copy an existing legacy profile while holding
its old instance lock; retain the source and never overwrite a durable profile.
Relocate desktop project paths contained within the copied profile.

Check required PGlite files before opening an existing desktop database. An
incomplete database must fail with its preserved location, never silently reset.
Recovery is an explicit operation on copies: rebuild a clean schema, recover user
rows, validate constraints and sequences, and test writes before adoption.

## Consequences

Manual work survives temporary-file cleanup. Old copies remain available for
recovery and require deliberate cleanup. The guard detects missing foundation
files; it is not a comprehensive database integrity check. Embedders continue
choosing their own storage, and deterministic test isolation is unchanged.
