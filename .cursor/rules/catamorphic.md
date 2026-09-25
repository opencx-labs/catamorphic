---
description: Core Catamorphic conventions for TypeScript changes (digest of AGENTS.md)
globs: **/*.ts,**/*.tsx
alwaysApply: false
---

# Catamorphic essentials

`AGENTS.md` is the source of truth. This is a digest; when they differ, follow `AGENTS.md`.

- **Embed first.** Catamorphic is libraries a host mounts in-process. The host supplies auth, identity, database, storage, sandbox and LLM credentials. Never add a standalone boot, default tenant, default user, or hard-coded path, port, or env layout. `apps/desktop` is the reference host.
- **Every dependency is an axis.** Hosts construct providers explicitly at boot: Postgres or PGlite; Cloudflare, Daytona, microsandbox, or local-process execution; S3-compatible or filesystem storage. Libraries never sniff env to pick one.
- **Postgres for state.** Queues, retries, pauses, batch state and schedules live in the host's Postgres (`SKIP LOCKED`), not new infrastructure.
- **Code is the source of truth.** Workflows and apps are TypeScript. Never invent a JSON format or DSL for workflow logic.
- **One Workflow model (ADR 0040).** Every workflow is an exported `defineWorkflow(({ defineBoundary, defineBatch }) => ({ steps: [...] }))`. IO lives in `"use step"` functions called from boundary bodies. Every run executes a deployed commit or session artifact. Do not add a public `stage`, a workflow category, or a separate Run family.
- **Step functions** take one destructured object parameter and carry JSDoc `@displayname` (plus `@icon`, `@description`, per-`@param` metadata).
- **Project capabilities live in `.catamorphic/` (ADR 0142).** Never write framework files or dependencies into a user project's root.
- **API types come from Zod.** After route or DTO changes run `(cd packages/fastify-plugin && bun run generate-spec)` then `(cd packages/api-client && bun run generate)`. After migrations run `bun run db:migrate && bun run db:codegen`.
- **Instrument hot paths** with `@catamorphic/otel` (`getTracer`, `withSpan`, `catamorphic.*` attributes). The host owns the OTel SDK.
- **Record settled design decisions** as ADRs in `docs/decisions/`.
- **TypeScript style:** see `typescript-style.mdc`.
- **Verify** with `bun run lint`, `bun run typecheck`, and `bun run test` while iterating, and `bun run check` before finishing.
- **Never commit or push** unless the user asks.
