# Agent Instructions

## Project Overview

Catamorphic is an open-source, local-first framework for **agentic work
environments**, plus a desktop app (`apps/desktop`) that is both the
framework's reference implementation and a polished daily-use product. A
*project* is a git repo that can hold any kind of work — docs, notes, data,
code, automations (workflows), and apps (ADR 0043). The framework's
co-equal capabilities: general-purpose projects, git-native work tracking
(per-turn checkpoint commits, remote sync, the CodeHost seam — ADR 0044),
multi-harness coding agents (ADR 0038, 0050), durable workflows, sandboxed
user-built apps (ADRs 0035–0037), and embedder sovereignty over feel and
doctrine (ADRs 0048, 0049). Never present Catamorphic as "a workflow
automation framework" — workflows are one capability among equals.

Where workflows and apps exist, they are TypeScript code — **the code is
strictly the source of truth**; we never invent DSLs or JSON formats for
workflow logic. The parser converts the TypeScript AST into a visual graph
rendered by React Flow so non-technical users can understand and (via AI
agents) build workflows, while technical users edit the code directly.
Workflow code must stay simple: easy for AI agents and humans to write and
edit, and intuitive to render. User workflows run like **regular apps** —
full IO, real npm dependencies, no restricted JS runtime — executed in
sandboxes (or local processes, ADR 0047) using **Bun**.

### Embeddable framework positioning (READ THIS FIRST)

**Catamorphic ships as libraries a host application mounts in-process.** There is no standalone product and no default identity. The host provides auth, user/org model, database, and the deployment surface. The root `bun run dev` is a dev convenience only: it boots the dev infra (docker-compose, sandbox bridge); libraries must never depend on that script. The in-repo reference host is the desktop app (`apps/desktop`, embedded server in `src/main/server/boot.ts`). The old web playground host was removed 2026-08 (severely out of date; will be rewritten from scratch if revisited).

Concrete implications for any change you make:

- Prefer designs that are **host-injectable**: DB connections/schemas, auth context, storage, sandbox credentials, LLM credentials, telemetry, trigger kinds, seeds/doctrine — all configurable/injectable, never hard-coded.
- Avoid assumptions that only hold in a single-process demo (a single global DB, a single user, a specific env layout, port, or filesystem path).
- When adding migrations, API routes, or packages, think first about how a host consumes them (library import, mountable Fastify plugin, schema-scoped migrations, generated client types). See `INTEGRATION.md`.
- Do not re-introduce a standalone boot, a default tenant, or a default user. Every request carries identity from the host's auth context.
- When a tradeoff exists between "nice for a demo" vs. "nice for embedding", embedding wins unless the user explicitly says otherwise.
- Mechanics vs. doctrine (ADR 0049): framework contracts belong in code and the `building-apps`-style mechanics seeds; anything about how work should *look* in a given host must stay replaceable via `projectSeeds` / `standingAgentPrompt`.

### Infrastructure priorities

- **Every dependency is an axis.** Postgres or pglite; cloud sandboxes (`@catamorphic/cloudflare` default cloud provider, `@catamorphic/daytona` alternate), local sandboxes (`@catamorphic/microsandbox`), or plain subprocesses (`@catamorphic/local-process`, trusted single-tenant only — ADR 0047); S3-compatible or filesystem code storage. Hosts construct backends explicitly at boot (ADRs 0008, 0012, 0047; see `apps/desktop/src/main/server/boot.ts` and `CLOUDFLARE.md`).
- **Postgres for everything stateful.** Tables live in a dedicated schema (default `catamorphic`). When you need queues or scheduling, build them on the same Postgres (`SKIP LOCKED`) instead of adding infrastructure.
- **OpenTelemetry throughout.** Libraries instrument with `@opentelemetry/api` only (via `@catamorphic/otel`); the host owns the SDK/exporters. New service methods on hot paths (runs, deploys, sandbox ops, project mutations) should get spans with `catamorphic.*` attributes. For dev, the repo-root docker-compose ships an OTel collector (:4317/:4318) writing to ClickHouse (:8124 HTTP / :19001 native, db `otel`); hosts register the host-side SDK themselves (see `INTEGRATION.md`).
- **Bun** for running, bundling, and inside sandboxes.

## Design Decisions (ADRs)

Settled decisions live in `docs/decisions/` as short ADRs, indexed in `docs/decisions/README.md`.

**When you and the user settle a non-trivial design decision (architecture, package boundaries, storage, execution, naming, dependencies), record it as a new ADR in the same change.** Copy `docs/decisions/0000-template.md`, number it sequentially, keep it under a page, and update the index. When a decision supersedes an old one, mark the old ADR as superseded rather than deleting it. Do not deviate from accepted ADRs without explicit user approval.

Big desktop design/philosophy choices are additionally logged in
`apps/desktop/DESIGN.md` (the design log).

## Monorepo Structure

Public developer surface:

- `packages/server-sdk` — **`@catamorphic/server-sdk`**: core backend SDK. `createCatamorphic({ database, storage, sandboxProvider?, github?, triggerKinds?, mcpToolKinds?, plugins?, projectSeeds?, standingAgentPrompt?, ... })`; identity binds per request via `forTenant({ tenantId }).forUser({ externalUserId })`.
- `packages/fastify-plugin` — **`@catamorphic/fastify-plugin`**: mountable Fastify plugin (`catamorphicPlugin`) + standalone `createApp` factory with Zod schemas and OpenAPI spec. Also serves the per-project MCP endpoints (`/projects/:id/mcp` — workflow tools + documents + skills + `ask_agent`, narrowed by identity (ADR 0055); `/projects/:id/apps-mcp` MCP Apps) and app guest documents.
- `packages/react` — headless React bindings (provider, TanStack Query hooks, jotai atoms).
- `packages/ui` — React Flow editor components (canvas, panels, AI bar) + `AppMount` (sandboxed app iframe host); all opt-in/composable.
- `packages/registry` — shadcn-style copy-paste component registry (projects list, git panel, runs panel, agent chat, Monaco editor, …).
- `packages/api-client` — generated OpenAPI types + openapi-fetch client.
- `packages/workflow` — **`@catamorphic/workflow`**: dependency-light `defineWorkflow`, boundary, batch-scope, pause, child-workflow, trigger-subscription, and physical batch-step authoring primitives; hosts may wrap and selectively re-export this surface.
- `packages/app` — **`@catamorphic/app`**: the guest runtime bundled into every user-built app (typed workflow client, persistent app-local storage shim, dual-dialect MCP Apps probe, `buildAppGuestDocument`) plus the **`@catamorphic/app/ui`** component kit, styled entirely by host theme tokens (ADR 0048).

Internal packages:

- `packages/core` — framework-agnostic service layer (the kernel behind server-sdk and fastify-plugin). Services include projects, workflows, runs, deployments, triggers (+ codegen), apps, app policies, **app storage**, plugins, secrets, agent sessions, agent context, **agent definitions** (ADR 0050), the coding-agent registry, **remote sync**, the **CodeHost seam** + `GithubService`, skills/seeds, and tenant policies. Seeds/doctrine hooks resolve once in the core constructor (ADR 0049).
- `packages/db` — Kysely instance, schema-scoped raw SQL migrations, programmatic `migrateToLatest`, codegen types.
- `packages/git` — vendor-neutral git-backed project storage (isomorphic-git): `StorageBackend`/`RemoteBackend` contracts, `ProjectManager`, the remote sync engine (`syncWithNetworkRemote` — fetch/merge/push/rescue branches, ADR 0044), filesystem backends.
- `packages/github` — **`@catamorphic/github`**: GitHub OAuth + device-flow helpers, REST API client, token stores. Consumed by core's `GithubService` (which implements `CodeHost`).
- `packages/parser` — ts-morph AST-to-WorkflowGraph parser; also the engine behind each project's seeded `scripts/check.ts`.
- `packages/sandbox` — vendor-neutral sandbox + coding-agent contracts (`SandboxProvider`, `SandboxManager`, `RunExecutor`, `CodingAgentProvider`), the stdio supervisor transport, `instrumentSandboxProvider`, plugin-doc staging helpers. No vendor SDKs here.
- `packages/microsandbox` — **`@catamorphic/microsandbox`**: local sandbox provider (the desktop's default execution).
- `packages/local-process` — **`@catamorphic/local-process`**: sandboxless subprocess execution with an explicit env; trusted single-tenant hosts only (ADR 0047).
- `packages/cloudflare` — **`@catamorphic/cloudflare`** backend plugin: `CloudflareSandboxProvider` (Bridge Worker client), `ArtifactsClient` + `ArtifactsRemoteBackend`.
- `packages/s3` — **`@catamorphic/s3`** backend plugin: `S3RemoteBackend` + `S3ObjectStore` store project origins in any S3-compatible bucket (ADR 0012).
- `packages/daytona` — **`@catamorphic/daytona`** backend plugin: `DaytonaSandboxProvider`, experimental Daytona git storage.
- `packages/ai-sdk` — **`@catamorphic/ai-sdk`** coding-agent harness: `AiSdkCodingAgent` (Vercel AI SDK tool loop, any API model) running in the host process; the desktop's built-in harness.
- `packages/claude-code` — **`@catamorphic/claude-code`** coding-agent harness backed by the Claude Agent SDK / Claude Code CLI: preset system prompt + settings-source fidelity (ADR 0045), `ask_user`, background-task events, per-session MCP servers (`mcpServersForSession`).
- `packages/codex` — **`@catamorphic/codex`** coding-agent harness (OpenAI Codex SDK).
- `packages/mcp` — **`@catamorphic/mcp`**: MCP client infrastructure — both protocol generations with auto-negotiation, elicitation (form + URL), official MCP registry search, plugin-marketplace fetch/install.
- `packages/otel` — OpenTelemetry helpers (`getTracer`, `withSpan`) over `@opentelemetry/api`.
- `packages/runtime` — workflow execution harness (runs inside the sandbox).
- `packages/plugins` — plugin manifest contract + resolvers (see [packages/plugins/README.md](packages/plugins/README.md)).
- `packages/cloudflare-sandbox-bridge` — deployable Worker exposing Cloudflare Sandbox over HTTP.

Apps:

- `apps/desktop` — the Catamorphic desktop app (Electron), the in-repo reference host: it embeds the server in-process (`src/main/server/boot.ts`) and consumes the same hooks as any embedder. It is also a **dev shell** (ADR 0045): Claude Code fidelity (CLAUDE.md/`.claude` honored), worktrees, Monaco diff tabs, sidebar Changes/PRs, ghostty/PTY terminals with OSC 133, embedded browser, command palette. See `apps/desktop/AGENTS.md` and `apps/desktop/DESIGN.md`. Catamorphic itself remains embed-only.
- `apps/pwa` — the mobile PWA (ADR 0058): phone-sized client of any Catamorphic server — projects → sessions → chat (queue/send-now nudge, interrupt, agent questions, tool-permission cards), connect-link auth, local profiles. Reaches a server three ways: an invite connect link, a desktop QR pairing (ADR 0060), or the stock server. See `apps/pwa/AGENTS.md`.
- `apps/server` — the stock self-hostable server (ADR 0059): `docker run`-able, zero external services (PGlite + bare git origins + local-process execution + `auth.json` bearer tokens), invites over `POST /admin/invites` (returns ready-to-send connect links), unique-per-install mDNS hostname for LAN reach, `DATABASE_URL` opt-in for real Postgres. **Single-tenant only** (ADR 0047). See `apps/server/AGENTS.md`.

How the three connect (setting up / troubleshooting, read in this order):

1. **Auth is always a bearer token resolved per request** (ADR 0055): desktop = fixed local identity on loopback; stock server = `auth.json` (admin token printed at boot; member tokens minted by invites, access lives in the *membership*); desktop-LAN = device tokens from QR pairing (hashes in `<userData>/mobile-pairing.json`).
2. **Invites are connect links**: `catamorphic://connect?server=<api base incl. /api>&token=…&project=…` — redeemable by the desktop (creates a synced remote project, ADR 0044/0055) and by the PWA (direct chat access).
3. **QR pairing** (ADR 0060, palette → "Continue on mobile"): the desktop's LAN listener serves the built `apps/pwa/dist` at its root, exchanges a single-use 2-minute code for a device token, and proxies `/api/*` to the loopback embedded server (bearer required). The claim also hands the phone the profile's remote-project links + mirror map, and the focused chat's project/session (deep-link). The QR ships the **built** PWA — rebuild `apps/pwa` after UI changes.
4. **Scoped members address agents as `project:<projectId>:<slug>`** — a bare session create is builder/root-only; the PWA derives the id from `GET /me`.
5. **Sessions mirror to the linked remote** (ADR 0061): after every settled turn on a remote-linked project the desktop pushes the transcript to `PUT …/agent/sessions/:id/mirror`; the server's copy is continuable there (history-seeded re-anchor), and a `409 diverged` means the server owns the fork — the desktop stops pushing and stamps its copy with a `mirror_fork` marker clients use to lock the stale copy and link the live one. When the focused project has a remote, the pairing QR defaults to the REMOTE origin with a `session` deep-link.
6. **Session privacy & usage** (ADR 0062): incognito is a DESKTOP-LOCAL concept — a session-id set in `<userData>/incognito-sessions.json` the mirror pusher skips; it never touches core's schema or any wire (palette "New incognito chat", Ghost badge on the dock). `.catamorphic/project.json` `"allowIncognito": false` is the committed team policy hiding the affordance; the stock server's `GET /admin/usage` rolls up per-member usage from message `metadata.usage`, mirrored desktop turns included.

## Skills

- `skills/embed-catamorphic/SKILL.md` — the public skill for embedding Catamorphic in a host product
- `.agents/skills/` — canonical repository-internal skills, following the
  [Agent Skills](https://agentskills.io) layout. `.cursor/skills` is a
  compatibility symlink to this directory.
- `.agents/skills/plugin-e2e-integration/SKILL.md` — business-agnostic end-to-end plugin integration flow
- `.agents/skills/using-catamorphic/SKILL.md` — embedding catamorphic in a host app (local dev linking)
- `.agents/skills/embedding-guide/SKILL.md`, `.agents/skills/api-type-safety/SKILL.md`, `.agents/skills/code-first-architecture/SKILL.md`, `.agents/skills/database-conventions/SKILL.md`, `.agents/skills/sandbox-agent-integration/SKILL.md`, `.agents/skills/workflow-code-conventions/SKILL.md`

Per-project seed skills that ship to every user project live in
`packages/core/src/seeds.ts` (`SEED_SKILLS`): `catamorphic-projects`,
`writing-workflows`, `batch-workflows`, `durable-workflows`,
`building-apps` (mechanics), `designing-apps` (replaceable doctrine).

## Verification Checklist

After **every** change, run all applicable checks before considering it complete. Do not skip any step.

### 1. Lint

```bash
bun run lint # from root — runs biome check on entire monorepo
bun run lint:fix # auto-fix safe issues
```

Zero errors and zero warnings. Use `bunx biome check --write --unsafe .` for unsafe fixes, then verify.

### 2. Typecheck

```bash
bun run typecheck # all packages from root via Turbo
```

Every `.ts`/`.tsx` change must pass with zero errors.

### 3. Build

```bash
bun run build # all packages from root via Turbo
```

Packages resolve each other via `dist/`: rebuild changed packages before a
desktop build or e2e run, or your changes silently don't ship.

### 4. Tests

```bash
bun run test # all packages from root via Turbo
```

All existing tests must pass. Desktop changes additionally require the
desktop checklist (`apps/desktop/AGENTS.md`), including `bun run test:e2e`.

### 5. Browser verification (after UI/integration changes)

Catamorphic has no standalone UI. Rebuild the affected packages, refresh the `file:` links in the host app, and verify in the **host's** browser (for desktop changes: launch the app, see `apps/desktop/AGENTS.md`). Check: surfaces render, zero console errors, no hydration mismatches.

### 6. Migration sync

```bash
bun run db:migrate && bun run db:codegen
```

### 7. API spec sync (after route/DTO changes)

```bash
cd packages/fastify-plugin && bun run generate-spec
cd packages/api-client && bun run generate
```

### 8. Never commit

Do not run `git add`, `git commit`, or `git push` unless the user explicitly asks.

### 9. Keep main CI green

CI runs the repository checks on every push to `main`. When you push to
`main`, monitor that workflow to completion and treat a failure as unfinished
work. A successful run is valid evidence for the checks it completed; keep
`main` green before reporting the work complete.

## Design Principles

Settled decisions — do not deviate without explicit user approval. ADRs in `docs/decisions/`; operational detail in `.cursor/rules/`:

- **Project model, git versioning, DB types** → `project-model.mdc`
- **Sandbox execution, providers, run lifecycle, instrumentation** → `sandbox-execution.mdc`
- **Editor UI: history sidebar, run panel, state management** → `playground-ui.mdc`
- **Canvas layout, nodes, edges, read-only behavior** → `graph-design.mdc`
- **Parser node types, containers, source ranges, provenance** → `parser-conventions.mdc`
- **Detail panel, code editor, bidirectional linking** → `panel-editor.mdc`
- **Test structure, parallelism, isolation, skip patterns** → `testing-conventions.mdc`

Voice and visual language for anything user-facing (site, README, app
strings, skills): `docs/DESIGN-LANGUAGE.md`. No em-dashes or en-dashes in
user-facing strings.

## Code Conventions

### Workflow Code Format

There is one Workflow model. Every workflow is an exported
`defineWorkflow(({ defineBoundary, defineBatch }) => ({ steps: [...] }))`
value from `@catamorphic/workflow`, and every run executes a deployed commit.
`defineBoundary` creates one atomic retry scope: when its callback fails,
every operation in that callback retries together. `defineBatch` creates a
paged per-item processing scope with an optional sink. Package-level
`defineBatchStep` may physically coalesce compatible calls only inside
`defineBatch.process`. These are Workflow capabilities, not separate public
categories, and `stage` is not a public authoring concept. IO lives in
`"use step"` functions called from boundary run bodies.

```typescript
import { type BoundaryContext, defineWorkflow } from "@catamorphic/workflow";

export const myWorkflow = defineWorkflow(({ defineBoundary }) => ({
  steps: [
    defineBoundary({
      run: async ({ input }: BoundaryContext<{ data: string }>) => {
        const result = await myStep({ data: input.data });
        return { result };
      },
    }),
  ],
}));
```

### Step Functions

All step functions take a **single destructured object parameter**. Every step function and every parameter **must** have JSDoc metadata with a `@displayname`.

```typescript
/**
 * @displayname Send Welcome Email
 * @icon mail
 * @param to - @displayname Recipient | @description Email address to send to
 * @param name - @displayname Recipient Name | @description The user's display name
 */
async function sendWelcomeEmail({ to, name }: { to: string; name: string }) {
 "use step";
}
```

Display name guidelines: step names are short action phrases ("Send Email"); parameter names are descriptive labels (`orderId` → "Order ID"). The UI converts TS types to friendly labels automatically (`string` → "Text", `boolean` → "True or False", etc.).

### TypeScript Style

See `typescript-style.mdc`. Key points: object params over positional, no `any`, no `as` casts, minimize `let`. Every public service/SDK method takes one keyed object parameter.

### API Routes

Define Zod schemas first, then register routes with `fastify-type-provider-zod`. Route URLs are prefix-relative (no hard-coded `/api`) — the plugin is mounted with `prefix: "/api"` by `createApp` and by hosts. After adding routes:

```bash
cd packages/fastify-plugin && bun run generate-spec
cd packages/api-client && bun run generate
```

### Database Changes

Forward-only raw SQL migrations in `packages/db/migrations/`. After changes:

```bash
bun run db:migrate # apply pending migrations
bun run db:codegen # regenerate TypeScript types
```

### Instrumentation

Use `@catamorphic/otel` (`getTracer("@catamorphic/<package>")` + `withSpan`). Attribute names use the `catamorphic.` prefix (`catamorphic.project.id`, `catamorphic.run.id`, `catamorphic.tenant.id`, `catamorphic.workflow.name`). Sandbox providers are auto-wrapped by `instrumentSandboxProvider` inside `CatamorphicCore` — do not double-wrap.

## Build Order

```
db → core → fastify-plugin → api-client
otel → sandbox → core
otel → core
git → core
git → s3
github → core
parser → core
parser → ui
app → sandbox
app → core
app → fastify-plugin
app → ui
workflow → runtime → sandbox → core
runtime → microsandbox
runtime → local-process
mcp → ai-sdk
core → claude-code
core → server-sdk
api-client → react → ui → registry
```
