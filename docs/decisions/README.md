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
| [0001](0001-code-is-the-source-of-truth.md) | Code is the source of truth for workflows and apps | Accepted (expanded by 0026) |
| [0002](0002-embeddable-library-architecture.md) | Embeddable library architecture (server-sdk / fastify-plugin / react) | Accepted (updated by 0026) |
| [0003](0003-postgres-schema-scoped-storage.md) | Postgres with schema-scoped tables, host-provided connection | Accepted |
| [0004](0004-cloudflare-first-infrastructure.md) | Cloudflare-first infrastructure (Sandbox now, Artifacts next) | Accepted (updated by 0008, 0012) |
| [0005](0005-opentelemetry-api-only-instrumentation.md) | OpenTelemetry instrumentation via `@opentelemetry/api` only | Accepted |
| [0006](0006-postgres-backed-queue-and-scheduling.md) | Postgres-backed job queue and scheduling | Accepted; execution queue implemented by 0014, 0016, 0023-0026; claim fairness updated by 0028 |
| [0007](0007-bun-and-unrestricted-workflow-runtime.md) | Bun runtime; workflows run as regular, unrestricted code | Accepted |
| [0008](0008-vendor-plugin-packages.md) | Vendor backends live in plugin packages (`@catamorphic/cloudflare`, `@catamorphic/daytona`) | Accepted |
| [0009](0009-pluggable-coding-agents.md) | Coding agents are pluggable; Flue is the flagship server-side agent | Superseded by 0018 |
| [0010](0010-skills-in-project-repo.md) | Per-project agent skills live in the project repo (`.agents/skills/`) | Accepted |
| [0011](0011-registry-distributed-monaco-editor.md) | Code editor ships as a registry item; linking state lives in React hooks | Accepted |
| [0012](0012-s3-compatible-origin-backend.md) | S3-compatible object storage as a git origin backend (`@catamorphic/s3`) | Accepted |
| [0013](0013-test-and-production-run-modes.md) | Explicit test and production workflow run modes | Accepted (updated by 0014, 0026) |
| [0014](0014-deployment-scoped-execution-runtimes.md) | Deployment-scoped execution runtimes | Accepted (updated by 0026) |
| [0015](0015-first-class-batch-workflows.md) | First-class batch workflows | Superseded by 0026 |
| [0016](0016-durable-runtime-event-reporting.md) | Persisted runtime event reporting | Accepted (updated by 0024, 0026) |
| [0017](0017-public-workflow-authoring-package.md) | Public workflow authoring package | Accepted (expanded by 0020, 0026) |
| [0018](0018-ai-sdk-coding-agent.md) | AI SDK ToolLoopAgent is the flagship coding agent | Accepted |
| [0019](0019-headless-agent-chat-and-dock.md) | Agent chat is headless state plus a controlled dock | Accepted |
| [0020](0020-typed-durable-workflow-boundaries.md) | Typed persisted workflow boundaries | Accepted (updated by 0026) |
| [0021](0021-durable-workflow-visualization.md) | Persisted workflow visualization | Accepted (updated by 0026) |
| [0022](0022-workflow-cancellation-semantics.md) | Workflow cancellation is a host run control | Accepted (implemented by 0025; updated by 0026) |
| [0023](0023-postgres-durable-boundary-execution.md) | Postgres boundary execution | Accepted (updated by 0026) |
| [0024](0024-postgres-durable-pauses.md) | Postgres persisted pauses and timeouts | Accepted (updated by 0026) |
| [0025](0025-durable-cancellation-state-machine.md) | Persisted cancellation state machine | Accepted (updated by 0026) |
| [0026](0026-unified-workflows-runs-and-batch-scopes.md) | Unified workflows, runs, and batch scopes | Accepted |
| [0027](0027-correlation-keys-and-external-signals.md) | Correlation keys and named external signals | Accepted |
| [0028](0028-shared-rate-budgets-and-tenant-execution-policy.md) | Shared rate budgets and host-owned tenant execution policy | Accepted; claim cost and rate accuracy corrected by 0029 |
| [0029](0029-queue-and-rate-correctness-at-scale.md) | Queue claim cost, lease fencing, and rate budget accuracy at scale | Accepted; retention gap it identified is closed by 0030 |
| [0030](0030-run-retention.md) | Run retention | Accepted |
