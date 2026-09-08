# Agent Capabilities Implementation Sequence

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the complete approved agent runtime, capability, remote execution, workflow enablement, process, Watch, personal artifact, and scheduling architecture as five testable breaking migrations.

**Architecture:** Work proceeds in dependency order. Each sub-plan leaves the monorepo usable and deletes the contract it replaces; later plans consume only the new interfaces. No compatibility adapters, dual writes, or legacy topology aliases survive their replacement phase.

**Tech Stack:** TypeScript, Bun, Zod, Kysely/Postgres and PGlite, Fastify/OpenAPI, MCP, Claude Agent SDK, Codex app-server JSON-RPC, React Query, Electron, Vitest, Playwright, OpenTelemetry.

**Spec:** `docs/superpowers/specs/2026-08-24-agent-runtime-capabilities-and-personal-artifacts-design.md`

## Global Constraints

- Workflow and app code stays TypeScript and remains the source of truth.
- Every canonical durable workflow Run executes an exact committed deployment.
- Personal artifacts never sync, deploy, or execute remotely.
- Remote unattended member execution requires an active `WorkflowEnablement` with exact connections and durable consent.
- Provider credentials remain in the control plane and never enter project files, Allocations, runners, logs, traces, or API results.
- Replace old contracts in place; do not add compatibility aliases or dual-write paths.
- Use `@catamorphic/otel` on new hot-path service methods.
- User-facing copy contains no em dashes or en dashes.
- Do not run `git add`, `git commit`, or `git push` without explicit user approval. Reviewable working-tree checkpoints replace the commit steps normally used by this skill.

## Ordered sub-plans

1. `2026-08-24-agent-runtime-and-provider-fidelity.md`
2. `2026-08-24-capability-gateway-and-allocation-runners.md`
3. `2026-08-24-workflow-enablement-and-member-delegation.md`
4. `2026-08-24-processes-tasks-and-watches.md`
5. `2026-08-24-personal-artifacts-schedules-and-ui.md`

Do not start a later sub-plan until the focused tests and repository-wide checks of the prior plan pass. Database migration numbers in these plans are reserved in this order: 058 through 062.

## Final verification

- [ ] Run `bun run lint` and require zero warnings and errors.
- [ ] Run `bun run typecheck` and require every Turbo package to pass.
- [ ] Run `bun run build` so every changed package is consumed through `dist`.
- [ ] Run `bun run test` and require all package suites to pass.
- [ ] Run `bun run db:migrate && bun run db:codegen` and confirm no generated diff is missing.
- [ ] Run API generation in `packages/fastify-plugin` and `packages/api-client`; require a clean second generation.
- [ ] Run the desktop checklist in `apps/desktop/AGENTS.md`, including `bun run test:e2e`.
- [ ] Launch the desktop host and verify approvals, process attachment, Watches, personal provenance, member enablement, and schedules with zero renderer or main-process console errors.
- [ ] Run `git diff --check` and inspect `git status --short`. Do not stage or commit without explicit approval.
