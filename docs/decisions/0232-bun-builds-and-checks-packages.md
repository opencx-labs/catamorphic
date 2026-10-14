# 0232 — Bun builds and type checks the packages

- **Status:** Accepted
- **Date:** 2026-10-14

## Context

Every workspace package built its JavaScript with tsup (esbuild underneath),
from its own `tsup.config.ts`: 30 near-identical files, one of them still
naming an entry deleted months ago. Type checking ran `tsgo` from
`@typescript/native-preview`, a July development build of the compiler that
`typescript` 7.0.2, already installed for declarations, now ships. Bun was
pinned at 1.3.14 for installs, scripts, the runner bundle (already built with
`Bun.build`), the Work server image and the Bun the desktop downloads for
sandboxes.

Bun 1.4.3 adds `bun check`, a port of typescript-go that reports the same
errors as `tsc` 7.0.2. Measured here it checks a package 3 to 4.6 times faster
than `tsgo` (core: 0.46 s against 2.15 s), and both report a planted error
identically.

## Decision

- **Bun 1.4.3 everywhere:** `packageManager`, CI, the Work server and test
  images, and the desktop's sandbox Bun (version and every platform's
  integrity). One Bun builds, installs and runs, as before.
- **`scripts/build-package.ts` replaces tsup.** A package lists its entries in
  a `bundle` field of its package.json; each lands at its path under `src/`,
  dependencies (and peer and optional ones) stay imports and the rest is
  inlined, as tsup did. `--watch` rebuilds without emptying `dist/`.
- **Chunks only where entries share state.** Bun renames every declaration a
  shared chunk exports (`class AgentSessionsService2`, so its `name` changes),
  where esbuild kept names. A build with one entry is one file, dynamic
  imports inline; `db`, `parser` and `sandbox`, whose entries share only
  stateless code (or run in separate processes), opt out of splitting. `codex`,
  `fastify-plugin` and `otel` keep a shared chunk because their entries share
  classes checked with `instanceof` or module state; their shared
  declarations' `name` values carry the suffix, which no code reads (error
  classes set their own `name`).
- Two export paths follow the sources:
  `@catamorphic/parser/layout` is `dist/layout-entry.js` (its declarations had
  pointed at a different module) and `@catamorphic/sandbox/attachments` is
  `dist/coding-agent/text-attachments.js`.
- **`bun check` type checks every package.** `tsc` stays for declarations,
  which Bun does not emit, and checks the root scripts project: Bun gives a
  `check` script precedence over its built-in, and the root's `check` is the
  merge gate.

Considered and kept:

- **Turbo.** `bun run --filter` now runs workspace scripts in dependency
  order, but has no task cache, and CI reuses passing suites by content hash
  through Turbo's cache (`docs/test-caching.md`).
- **Vitest on the pinned Node.** `bun test` would run the suites on Bun, not
  the Node that Electron and the tests deliberately share, and rewrite more
  than 400 test files' mocks and environments.

## Consequences

- No tsup, esbuild-through-tsup or `@typescript/native-preview`; esbuild
  remains only where Vite, electron-vite and Wrangler bring it.
- A package with a new entry adds it to `bundle.entry`; the script refuses an
  entry outside `src/` or one that does not exist.
- Bun 1.4 tightened TLS defaults (`tls.connect` verifies the host name,
  `Bun.connect` rejects unauthorized certificates by default). Sandboxed code
  and the Work server inherit that.
- Developers need Bun 1.4.3 or newer: an older Bun has no `bun check`.
