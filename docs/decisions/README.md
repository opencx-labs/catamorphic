# Design decisions (ADRs)

Settled design decisions live here as short Architecture Decision Records. They are the durable memory of *why* the codebase looks the way it does.

**Process** (see also `AGENTS.md` → Design Decisions):

1. When a non-trivial design decision is settled with the project owner, add an ADR **in the same change** — copy [`0000-template.md`](0000-template.md), number it sequentially, keep it under a page.
2. Update the index below.
3. When a decision replaces an old one, add a new ADR and mark the old one **Superseded by NNNN** — don't delete or rewrite history.
4. Accepted ADRs are binding: don't deviate without explicit approval (which produces a new ADR).

## Index

| # | Title | Status |
| --- | --- | --- |
| [0001](0001-code-is-the-source-of-truth.md) | Code is the source of truth for workflows and apps | Accepted |
| [0002](0002-embeddable-library-architecture.md) | Embeddable library architecture (server-sdk / fastify-plugin / react) | Accepted |
| [0003](0003-postgres-schema-scoped-storage.md) | Postgres with schema-scoped tables, host-provided connection | Accepted |
| [0004](0004-cloudflare-first-infrastructure.md) | Cloudflare-first infrastructure (Sandbox now, Artifacts next) | Accepted |
| [0005](0005-opentelemetry-api-only-instrumentation.md) | OpenTelemetry instrumentation via `@opentelemetry/api` only | Accepted |
| [0006](0006-postgres-backed-queue-and-scheduling.md) | Postgres-backed job queue and scheduling | Accepted (not yet implemented) |
| [0007](0007-bun-and-unrestricted-workflow-runtime.md) | Bun runtime; workflows run as regular, unrestricted code | Accepted |
| [0008](0008-vendor-plugin-packages.md) | Vendor backends live in plugin packages (`@catamorphic/cloudflare`, `@catamorphic/daytona`) | Accepted |
| [0009](0009-pluggable-coding-agents.md) | Coding agents are pluggable; Flue is the flagship server-side agent | Accepted |
| [0010](0010-skills-in-project-repo.md) | Per-project agent skills live in the project repo (`.agents/skills/`) | Accepted |
| [0011](0011-registry-distributed-monaco-editor.md) | Code editor ships as a registry item; linking state lives in React hooks | Accepted |
| [0012](0012-s3-compatible-origin-backend.md) | S3-compatible object storage as a git origin backend (`@catamorphic/s3`) | Accepted |
