---
description: Catamorphic project conventions
globs: ["**/*.ts", "**/*.tsx"]
---

# Catamorphic Rules

- **Embeddable framework.** Catamorphic ships as libraries that a host application mounts in-process. There is no standalone product and no default identity (the root `bun run dev` only boots the reference playground host + its dev infra). Every architectural decision should assume the host provides the user model, auth, database connection, and deployment surface. Favor designs that make embedding easier (configurable providers, injectable DB/schema, pluggable auth, no hard-coded env/paths); never re-introduce standalone fallbacks.
- **Code is the source of truth.** Workflows are TypeScript, never JSON/DSL. The parser (ts-morph) converts AST to WorkflowGraph.
- **Cloudflare-first infra; Postgres for state.** Cloudflare Sandbox is the default execution provider; run queues, retries, pauses, batch state, and scheduling use the host's Postgres, not new infrastructure.
- **Instrument with OpenTelemetry.** Use `@catamorphic/otel` (`getTracer` + `withSpan`, `catamorphic.*` attributes) for hot paths; the host owns the OTel SDK.
- **Record settled design decisions as ADRs** in `docs/decisions/` (see `AGENTS.md` → Design Decisions).
- All step functions take a single destructured object parameter.
- There is one Workflow and one Run model. Plain exact `"use workflow"`
  functions lack persisted continuation. `defineWorkflow` composes builder-scoped
  `defineBoundary` and `defineBatch`; `defineBatchStep` only physically coalesces
  compatible calls inside `defineBatch.process`. Never add a public stage or
  capability-specific Run family.
- Use JSDoc tags (@displayname, @icon, @description, @param) for UI metadata.
- Zod schemas are the single source of truth for API types.
- After adding API routes, regenerate: `cd packages/fastify-plugin && bun run generate-spec && cd ../api-client && bun run generate`
- After migration changes: `bun run db:migrate && bun run db:codegen`
- Always typecheck with `tsgo` after changes.
- Never commit without explicit user request.
- Use objects as function parameters, not positional params.
- Avoid `any` type. Minimize mutable state.
