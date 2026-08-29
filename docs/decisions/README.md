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
| [0013](0013-test-and-production-run-modes.md) | Explicit test and production workflow run modes | Superseded by 0040 |
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
| [0031](0031-execution-hot-path-costs.md) | Execution hot-path costs: parked deferrals, bucket round trips, heartbeat HOT updates | Accepted |
| [0032](0032-projects-are-bun-workspaces.md) | Projects are bun workspaces holding workflows, contracts, and apps | Accepted |
| [0033](0033-user-declared-secrets.md) | Projects declare their own secrets in code | Accepted (RunStage terminology refined by 0064) |
| [0034](0034-batch-write-scalability-and-claim-receipts.md) | Batch admission counters, concurrent sinks, and claim receipts | Accepted |
| [0035](0035-app-entity-and-build-pipeline.md) | App entity, build pipeline, and bundle storage | Accepted |
| [0036](0036-app-authorization-and-audience.md) | App authorization: contract surface, frozen sets, audience identities | Accepted (audience headers superseded by 0053) |
| [0037](0037-app-guest-runtime-and-mount.md) | App guest runtime (`@catamorphic/app`) and host mount | Accepted (mount headers + polling superseded by 0053) |
| [0038](0038-coding-agent-registry-and-host-execution.md) | Coding-agent registry: per-session agents, host execution, effort | Accepted (runtime contract refined by 0067; topology model superseded by 0067) |
| [0039](0039-custom-trigger-kinds.md) | Custom trigger kinds: host-defined events, typed bindings, sync firing | Accepted |
| [0040](0040-one-workflow-model.md) | One workflow model: every workflow is `defineWorkflow`, every run a deployed commit | Accepted |
| [0041](0041-generated-projections.md) | Generated projections: schemas and types derived from code | Accepted |
| [0042](0042-parameterized-trigger-kinds-and-workflow-tools-mcp.md) | Parameterized trigger kinds (holes) and workflow tools over MCP | Accepted |
| [0043](0043-general-purpose-projects.md) | Projects are general-purpose; the workflow workspace is scaffolded on demand | Accepted |
| [0044](0044-checkpoint-commits-and-remote-sync.md) | Checkpoint commits, remote sync, and the code-host seam | Accepted |
| [0045](0045-desktop-as-dev-shell.md) | The desktop is a dev shell: harness fidelity, worktrees, diffs, PRs | Accepted |
| [0046](0046-plugin-activation-planes.md) | Plugin activation planes: capability providers and project lifecycle hooks | Accepted |
| [0047](0047-local-process-execution.md) | Sandboxless execution is a provider: `@catamorphic/local-process` | Accepted (provider selection refined by 0064) |
| [0048](0048-app-feel-is-the-embedders.md) | An app's feel is entirely the embedder's: neutral kit defaults, host feel tokens | Accepted |
| [0049](0049-doctrine-is-the-embedders.md) | Doctrine is the embedder's: seed/template/standing-prompt hooks, mechanics split from design doctrine | Accepted (templates part superseded by 0051) |
| [0050](0050-project-agent-definitions.md) | Project agent definitions: committed `agents/*.json`, consent-bound credentials | Accepted |
| [0051](0051-no-project-templates.md) | No project templates: agents build from skills | Accepted |
| [0052](0052-skills-as-commands.md) | Skills as commands, and the agent-initiated auth loop | Accepted |
| [0053](0053-identity-scope-and-app-routes.md) | Identity scope: one artifact vocabulary, structural narrowing, synchronous calls | Accepted |
| [0054](0054-tool-permissions.md) | Tool permissions: layered connection/agent policies that intersect; ask via host prompt | Accepted (enforcement transport refined by 0067) |
| [0055](0055-company-brain-roles-store-and-change-loop.md) | Company brain: program vs. project store, roles as files, scoped agents, the change loop | Accepted |
| [0056](0056-agent-configuration.md) | Agent configuration: one surface, layered defaults, enforced capabilities | Accepted |
| [0057](0057-agent-usage-and-cost.md) | Agent usage and cost: transcript-scanned page, per-turn usage in metadata | Accepted |
| [0058](0058-mobile-pwa.md) | The mobile PWA: chats on the go, wrapper-ready; tool asks answerable over HTTP | Accepted |
| [0059](0059-stock-server.md) | The stock server: zero-dependency, disk-backed, invite-first; mDNS LAN discovery | Accepted (auth, invites, and administration superseded by 0071 and 0072) |
| [0060](0060-continue-on-mobile.md) | Continue on mobile: QR pairing, bearer-gated LAN proxy, remote-link handoff | Accepted |
| [0061](0061-session-mirroring.md) | Session mirroring: local-first chats pushed to the linked remote; fork-on-continuation | Accepted |
| [0062](0062-session-privacy-and-fork-ux.md) | Session privacy & fork UX: incognito sessions, project policy, fork markers, admin usage | Accepted (admin-token usage route superseded by 0072) |
| [0063](0063-agent-checkout-coordination.md) | Agent coordination and optional worktree isolation | Accepted |
| [0064](0064-execution-environments-and-allocations.md) | Execution Environments and immutable Allocations | Accepted (agent placement model superseded by 0067; missing project policy refined by 0070) |
| [0065](0065-credential-connections-and-capability-broker.md) | Credential connections and capability broker | Accepted (refined by 0066 and 0068) |
| [0066](0066-greenfield-environment-and-connection-cutover.md) | Greenfield Environment and connection cutover | Accepted (service-only unattended rule superseded by 0068) |
| [0067](0067-long-lived-agent-runtimes-and-capability-gateway.md) | Long-lived agent runtimes and a unified capability gateway | Accepted |
| [0068](0068-personal-artifacts-and-workflow-enablement.md) | Local personal artifacts and explicit workflow enablement | Accepted |
| [0069](0069-host-owned-processes-watches-and-schedules.md) | Host-owned processes, watches, wakeups, and schedules | Accepted |
| [0070](0070-default-local-environment-policy.md) | Default local Environment policy | Accepted |
| [0071](0071-stock-auth-and-agent-driven-setup.md) | Stock auth and agent-driven setup | Accepted |
| [0072](0072-remote-oauth-admission-and-project-administration.md) | Remote OAuth, admission, and project administration | Accepted |
| [0073](0073-recoverable-project-remotes-and-builder-checkout.md) | Recoverable project remotes and builder checkout | Accepted |
| [0074](0074-temporary-watchers-and-session-delivery.md) | Temporary Watchers and durable session delivery | Accepted (Watcher trigger model superseded by 0076) |
| [0075](0075-parallel-local-development-isolation.md) | Parallel local development isolation | Accepted |
| [0076](0076-watchers-are-workflow-enablement.md) | Watchers are temporary workflow enablements | Accepted |
