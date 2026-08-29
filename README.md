<p align="center">
  <img src=".github/readme-banner.png" alt="Catamorphic: a really good place to get work done" width="100%">
</p>

# Catamorphic

**A really good place to get work done.** Catamorphic puts everything you
need for real work in one place: projects, documents, browser tabs, terminals,
editors, apps, automations, and agents that work on those same surfaces. It is
free, open source, and local-first. Your work is made of files, git history,
and databases you control.

Use Catamorphic as a personal brain on your Mac, run a shared brain on your own
server, or embed the same foundations in a product you already operate.

## Install the desktop alpha

The first public desktop line supports Apple silicon Macs running macOS 12 or
newer.

```bash
brew install --cask opencx-labs/tap/catamorphic
```

You can also download the signed and notarized DMG from
[GitHub Releases](https://github.com/opencx-labs/catamorphic/releases) and drag
Catamorphic into Applications.

> Catamorphic is in alpha. Project files and git history are durable, but app
> state and APIs may change between prereleases. Back up important projects
> and read the release notes before upgrading.

## One system, three ways to use it

### Desktop app

The desktop app ([`apps/desktop`](apps/desktop)) is a local-first workspace and
the framework's reference implementation. Claude Code, Codex, and API models
can work side by side in durable sessions. Agents use the browser, terminals,
editors, project files, apps, and connectors you can also use yourself. You can
take over a surface at any moment, inspect diffs when a change deserves your
eyes, or trust routine work to continue.

Projects are ordinary folders and git repositories. Every agent turn that
changes files creates a checkpoint commit. Local execution uses an embedded
database and local sandboxes, so the desktop does not depend on a hosted
Catamorphic service.

### Self-hosted server

The stock server ([`apps/server`](apps/server)) gives a personal or company
brain an always-on home. It serves the mobile PWA, remote agents, project apps,
and MCP endpoints. Desktop and mobile clients sign in through OAuth with PKCE;
the stock host supports local credentials and configured OAuth or OIDC
providers. Invitations grant admission after sign-in, and committed project
roles decide what each member and agent may do.

The zero-service setup keeps PGlite, git origins, credentials, and project data
under one data directory. A deployment can opt into real Postgres as it grows.
The stock host is single-tenant because its local-process execution can access
the host machine. Run one trusted organization or household per deployment.
See [the server guide](apps/server/README.md) or give an agent
[`skills/setup-catamorphic-server`](skills/setup-catamorphic-server/SKILL.md)
to provision it.

### Embeddable framework

The packages under [`packages/`](packages) let a host application mount
Catamorphic in-process without adopting Catamorphic's identity, deployment, or
design choices. A host supplies auth, users and organizations, database,
storage, execution providers, credentials, telemetry, skills, and doctrine.
The framework supplies general-purpose projects, git-native work tracking,
multi-harness coding agents, durable TypeScript workflows, sandboxed
user-built apps, generated API clients, headless React state, and composable
UI. See [`INTEGRATION.md`](INTEGRATION.md).

## Personal and company brains

- **A personal brain.** Keep notes, research, code, recurring work, and small
  tools in projects on your Mac. Add a stock server when you want the same
  projects and conversations from your phone or while the Mac is asleep.
- **A company brain.** Put shared knowledge, automations, apps, and tuned agent
  roles in one reviewable project program. Members sign in with their own
  identity and receive only the roles and project store paths they need. The
  same brain is available from desktop, the hosted PWA, an MCP client, or an
  embedded product surface.
- **A daily-driver dev shell.** Import a monorepo with its existing agent
  instructions. Worktrees, terminals, browser tabs, diffs, pull requests, and
  multiple coding harnesses live in one window.
- **An embedded copilot.** Mount the libraries in a SaaS backend, add the
  React surfaces you want, and give the agent the host's skills, tools,
  trigger kinds, look, and doctrine.
- **Per-customer tools over MCP.** Give each customer a project where agents
  build typed workflows and apps, then serve the approved tools to the MCP
  client they already use.

Desktop and server are designed to compose. A linked project's files sync over
git after settled turns. Desktop conversations mirror to the server, so the
mobile PWA can open the same chat and continue with the server's always-on
agent. If someone continues remotely, the server owns that conversation fork
instead of pretending two writers have one history. Incognito desktop chats
stay local and are never mirrored.

**Code is the source of truth.** Everything is stored as plain files
(TypeScript, markdown, whatever the work is) in a git repository, never a
proprietary DSL or an opaque store. When a project holds workflows, the
parser renders the workflow code as an intuitive visual graph for
non-technical users, while technical users and AI agents work directly with
the code. A project is just a git repo.

---

# What's inside

Six capabilities, co-equal. Each is shipped and verifiable in this repo;
the ADR column is the settled design record.

## Projects hold any work

A project is a folder that can hold documents, notes, data, plans, code,
automations, and apps, in any mix. A blank project is a git repository, a
`.catamorphic/project.json` manifest, and hidden seed skills; nothing in
the visible tree claims the project is about code. The workflow/app
workspace (a bun workspace: `contracts/`, `workflows/`, `apps/*`) is
scaffolded on demand, the first time someone asks for an automation or
app. Imported repositories are adopted as-is; existing files are never
overwritten. (ADRs [0032](docs/decisions/0032-projects-are-bun-workspaces.md),
[0043](docs/decisions/0043-general-purpose-projects.md))

## Git-native work tracking

Work is tracked without anyone performing git. Every agent turn that
changed files ends in a **checkpoint commit**, its sha stamped on the chat
message, so every reply's diff is addressable forever. Linked projects
sync with their remote automatically (fetch, fast-forward, merge, push);
a conflicting divergence lands on a **rescue branch** instead of a stuck
state, so no work is ever stranded. Everything provider-specific sits
behind one `CodeHost` interface; GitHub is the first implementation
(connect, repo import, pull requests). Agents get explicit git verbs
(`sync_project`, `create_pull_request`) rather than raw git.
(ADR [0044](docs/decisions/0044-checkpoint-commits-and-remote-sync.md))

## Coding agents, multi-harness

One agent-session engine over pluggable harnesses: the built-in
`@catamorphic/ai-sdk` tool loop (any API model), Claude Code
(`@catamorphic/claude-code`), and Codex (`@catamorphic/codex`), selectable
per session and switchable mid-session, with a normalized effort scale.
Agents run either in a sandbox or directly on the host filesystem.
`ask_user` questions, durable sessions that survive restarts, and
per-profile agent rosters work across harnesses. MCP goes both directions:
agents consume MCP connectors (registry search, plugin marketplaces,
elicitation via `@catamorphic/mcp`), and a project's workflows are served
*as* MCP tools to any MCP client. In the desktop, agents also drive the
workspace itself: browser tabs, terminals, `open_surface`, `point_at`.
(ADRs [0038](docs/decisions/0038-coding-agent-registry-and-host-execution.md),
[0042](docs/decisions/0042-parameterized-trigger-kinds-and-workflow-tools-mcp.md))

Concurrent sessions start in the same visible project checkout. Before a
turn, each agent sees the other active sessions in that project and can read
their bounded transcripts. It can keep sharing the folder, wait, or use the
same harness-neutral tools to create or adopt a Git worktree. Per-agent
coordination doctrine ranges from `shared-first` to `isolation-required`, so
non-technical roles can stay in one familiar folder while engineering agents
isolate only when needed. Shared sessions deliberately share files, Git
state, checkpoint commits, and rollback; Catamorphic does not pretend those
changes belong to one agent. (ADR
[0063](docs/decisions/0063-agent-checkout-coordination.md))

**Project agent definitions**: an agent can be a work product. Committed
`agents/<slug>.json` files (plus an optional `agents/<slug>.md` persona)
version with the project and appear in every collaborator's picker. A
committed definition never runs on your personal credentials until you
consent, and consent is bound to a hash of what you approved; definitions
using a project secret need no personal consent and work headlessly.
(ADR [0050](docs/decisions/0050-project-agent-definitions.md))

## Durable workflows

TypeScript automations in git, rendered as a visual graph for
non-technical users, executed durably on Postgres. One model: every
workflow is an exported `defineWorkflow` value, every run executes a
deployed commit. Boundaries (atomic retry scopes), batch scopes, pauses
and signals, correlation keys, shared rate budgets, retention, and
triggers, including host-defined trigger kinds with typed payloads and
sync-until-first-wait firing. Full authoring model below.

## Apps

Real frontends users (and agents) build on top of workflows: sandboxed
React bundles wired through a typed contract that cannot drift from the
workflows it calls (same repo, same commit). An app's callable workflow
set is frozen per published version and re-authorized on every call. Apps
interoperate with **MCP Apps** in both directions: the desktop renders MCP
Apps from connectors, and `/projects/:id/apps-mcp` serves your apps to MCP
hosts like Claude, unchanged. Apps get persistent app-local storage per
(app, user), and the `@catamorphic/app/ui` kit gives agent-built apps
polished, accessible components with zero CSS.
(ADRs [0035](docs/decisions/0035-app-entity-and-build-pipeline.md) through
[0037](docs/decisions/0037-app-guest-runtime-and-mount.md),
[0048](docs/decisions/0048-app-feel-is-the-embedders.md))

## The dev shell (desktop)

Import a real monorepo and use the desktop as your daily driver. The
Claude Code harness runs at full fidelity: the SDK's own preset system
prompt, and the repo's CLAUDE.md, `.claude/` skills, agents, commands, and
settings load exactly as in the CLI. Worktrees are first-class: discovered,
listed, diffed, and assignable by agents when concurrent work needs
isolation. Checkout management is harness-neutral, so Claude Code, Codex,
and the built-in agent follow the same policy. Diff tabs render in Monaco;
the sidebar has Changes and Pull Requests sections; PR review opens per-file
diffs through the CodeHost seam. Terminals are real PTYs with shell
integration (OSC 133); the embedded browser and the command palette round
out the shell. All of it degrades quietly for non-technical users.
(ADRs [0045](docs/decisions/0045-desktop-as-dev-shell.md),
[0063](docs/decisions/0063-agent-checkout-coordination.md))

## Your product, your feel and doctrine (embedding)

Apps and agents inside an embedder's product are unmistakably the
embedder's. **Feel**: the app kit ships structure and behavior only; every
aesthetic decision flows from host theme tokens with neutral defaults,
plus `hostCss` and `kit: false` for total control. **Doctrine**: two
`createCatamorphic` hooks (`projectSeeds`, `standingAgentPrompt`) receive
the framework defaults and return the host-final set, so seeded skills
and the agents' standing prompt are both replaceable. The desktop
consumes the same hooks and passes nothing: the proof the defaults are
real defaults.
(ADRs [0048](docs/decisions/0048-app-feel-is-the-embedders.md),
[0049](docs/decisions/0049-doctrine-is-the-embedders.md))

# The framework

Catamorphic's engine ships as libraries a host application mounts
in-process. The desktop app is itself such a host. The host provides auth,
the user/org model, the database, and the deployment surface. There is no
default identity or tenant: every request carries identity from the host's
auth context. See [`INTEGRATION.md`](INTEGRATION.md) for the host
integration flow.

## Runs anywhere

Durable agent-and-workflow infrastructure that does **not** assume an external
server.
Every dependency is an axis with a heavy and a light end. Pick per axis:

| Axis | Heavy end | Light end |
| --- | --- | --- |
| Database | Network Postgres (`{ pool }` / `{ connectionString }`) | **Embedded pglite** (Kysely `PGliteDialect` via `database: { db }`; migrations run statement-by-statement so single-connection dialects just work) |
| Execution | Cloud sandboxes: `@catamorphic/cloudflare`, `@catamorphic/daytona` | **Local sandboxes** (`@catamorphic/microsandbox`), plain local processes (`@catamorphic/local-process`, trusted single-tenant hosts only), or none (read-only embed) |
| Code storage | S3-compatible bucket (`@catamorphic/s3`) or Cloudflare Artifacts | Two writable directories |
| Identity | Host org/user per request | One fixed tenant/user |
| Surface | HTTP API + React UI | In-process SDK calls, or migrations-only |

**The desktop app is the proof**: it runs the lightest column end to end
(pglite, local sandboxes, filesystem storage, no external server) by design
([`apps/desktop/src/main/server/boot.ts`](apps/desktop/src/main/server/boot.ts)).
No durable-execution vendor can run entirely inside a desktop app; this one
does, and the same substrate is what offline-first agents need. Full matrix
and host shapes: [`INTEGRATION.md`](INTEGRATION.md#host-shapes-catamorphic-runs-wherever-typescript-runs).

Also worth knowing, because it's easy to miss from the package list:

- **The product teaches agents from the inside.** Every project is seeded
  with hidden skills (`.agents/skills/`): the project model and on-demand
  workspace scaffold (`catamorphic-projects`), workflow authoring
  (`writing-workflows`, `batch-workflows`, `durable-workflows`), and app
  building split into mechanics (`building-apps`) and replaceable design
  doctrine (`designing-apps`). Coding agents learn Catamorphic's authoring
  model at the moment they need it. The public
  [`skills/setup-catamorphic-server`](skills/setup-catamorphic-server/SKILL.md)
  skill extends the same idea to stock-server setup and integrating
  Catamorphic into an existing app without replacing its auth or deployment.
- **One Run model.** Boundary and batch workflows all share the same Runs
  API, hooks, and UI: capabilities, not categories. Every run executes a
  deployed commit.
- **Observability is free for hosts.** Everything instruments against
  `@opentelemetry/api`; register your SDK and Catamorphic's spans appear in
  your traces.

## The developer surface

| Package | What it is |
| --- | --- |
| `@catamorphic/server-sdk` | The core SDK for your Node/Bun backend. Takes a Postgres connection (or `pg.Pool`), manages its own schema-scoped tables and migrations, and exposes projects, workflows, files, runs, triggers, agent sessions, and GitHub. |
| `@catamorphic/fastify-plugin` | A mountable Fastify plugin (`app.register(catamorphicPlugin, { core, prefix: "/api" })`) exposing the standard HTTP API for frontends, plus the per-project MCP endpoints. Also exports a standalone `createApp` factory for sidecar deployments. |
| `@catamorphic/react` | Headless React bindings: `CatamorphicProvider`, TanStack Query hooks, and jotai atoms. Build a fully custom UI on top of these. |
| `@catamorphic/ui` | Ready-made components: the React Flow workflow canvas, detail panel, history sidebar, AI bar, and `AppMount` (the sandboxed app iframe host). Every piece is opt-in. |
| `@catamorphic/registry` | shadcn-style copy-paste components for hosts that want to own and customize the component source (project browser, git panel, runs panel, agent chat, Monaco editor). |
| `@catamorphic/api-client` | Generated OpenAPI types + `openapi-fetch` client for the HTTP API. |
| `@catamorphic/workflow` | Typed workflow-authoring primitives. Projects opt in directly, or a SaaS can wrap it and re-export only its approved surface. |
| `@catamorphic/app` | The guest-side app runtime bundled into every user-built app: typed workflow client, persistent app-local storage shim, dual-dialect MCP Apps support, and the `@catamorphic/app/ui` component kit styled entirely by host theme tokens. |

Supporting packages (consumed through the surface above, importable directly for advanced wiring):

| Package | What it is |
| --- | --- |
| `@catamorphic/core` | Framework-agnostic service layer: projects, workflows, runs, deployments, triggers, apps, app storage, plugins, secrets, agent sessions, agent definitions, remote sync, and the CodeHost seam. The kernel behind `server-sdk` and `fastify-plugin`. |
| `@catamorphic/db` | Kysely + Postgres. Schema-scoped (default schema `catamorphic`), raw SQL migrations, programmatic `migrateToLatest`. |
| `@catamorphic/git` | Git-backed project storage (`isomorphic-git`): per-user working copies, pluggable origin remotes (`RemoteBackend`), and the remote sync engine (`syncWithNetworkRemote`: fetch, fast-forward, merge, push, rescue branches). |
| `@catamorphic/github` | GitHub as a code host: OAuth + device-flow auth helpers, the REST API client, token stores. Feeds core's `GithubService` and its `CodeHost` implementation. |
| `@catamorphic/parser` | ts-morph AST → `WorkflowGraph` parser + dagre layout; also powers the seeded project `check` script. |
| `@catamorphic/sandbox` | Vendor-neutral sandbox + coding-agent contracts (`SandboxProvider`, `SandboxManager`, `RunExecutor`, `CodingAgentProvider`), the stdio supervisor transport, OTel instrumentation. |
| `@catamorphic/microsandbox` | Local sandbox provider over the microsandbox SDK: the desktop's default execution. |
| `@catamorphic/local-process` | Sandboxless execution as plain subprocesses with an explicit env. Trusted single-tenant hosts only (ADR 0047). |
| `@catamorphic/cloudflare` | Cloudflare backend plugin: `CloudflareSandboxProvider` (execution via Bridge Worker) + `ArtifactsRemoteBackend` (Cloudflare-native code storage when available). |
| `@catamorphic/s3` | S3-compatible git origin backend for Cloudflare R2, AWS S3, MinIO, and similar stores. |
| `@catamorphic/daytona` | Daytona backend plugin: `DaytonaSandboxProvider` + experimental Daytona git storage. |
| `@catamorphic/ai-sdk` | Built-in coding-agent harness: Vercel AI SDK tool loop on any API model, running in the host and driving the dev sandbox remotely. |
| `@catamorphic/claude-code` | Coding-agent harness backed by the Claude Code (Claude Agent SDK) CLI, with per-session MCP servers and full settings-source fidelity. |
| `@catamorphic/codex` | Coding-agent harness backed by the OpenAI Codex SDK. |
| `@catamorphic/mcp` | MCP client infrastructure: both protocol generations with auto-negotiation, elicitation, the official MCP registry search, and plugin-marketplace install. |
| `@catamorphic/otel` | Tiny OpenTelemetry helpers (`@opentelemetry/api` only: the host owns the SDK/exporters). |
| `@catamorphic/runtime` | Execution harness that runs *inside* the sandbox and reports step results. |
| `@catamorphic/plugins` | Plugin manifest contract + resolvers for host-provided packages and secrets. |
| `@catamorphic/cloudflare-sandbox-bridge` | Deployable Cloudflare Worker exposing Cloudflare Sandbox over HTTP. |

The in-repo reference host is the Catamorphic desktop app ([`apps/desktop`](apps/desktop)): an Electron app that embeds the server in-process (`src/main/server/boot.ts`).

## Design principles

- **Workflows are regular code.** User-defined workflows run like normal apps: full IO, real npm dependencies, no crippled JS runtime. Execution happens inside a sandbox (or a local process, where the host shape allows it) using **Bun** to run and bundle.
- **Code stays simple.** Both AI agents and humans must be able to write, edit, and understand workflows, and the parser must render them intuitively for non-technical users. See the code format below.
- **Host-injectable everything.** Database connections, storage backends, sandbox credentials, LLM credentials, telemetry, trigger kinds, seeds, and doctrine are all injected by the host: nothing is hard-coded.
- **Postgres is authoritative** for runs, retries, pauses, batch-item state, queues, and scheduling via `SKIP LOCKED`. Cloudflare Sandbox is the default cloud execution provider; backends ship as vendor plugin packages so hosts install only what they use.
- **OpenTelemetry throughout.** Libraries instrument against `@opentelemetry/api` only; the host registers the SDK and exporters and gets full traces for free.

Settled design decisions are recorded as ADRs in [`docs/decisions/`](docs/decisions/README.md).

## Quick start (embedding)

```ts
import { CloudflareSandboxProvider } from "@catamorphic/cloudflare";
import { createCatamorphic } from "@catamorphic/server-sdk";

// Boot once per process
const catamorphic = createCatamorphic({
  database: { connectionString: process.env.DATABASE_URL! }, // or { pool }
  storage: {
    projectsPath: process.env.CATAMORPHIC_PROJECTS_PATH!,
    remotesPath: process.env.CATAMORPHIC_REMOTES_PATH!,
  },
  // Backend plugins: @catamorphic/cloudflare, @catamorphic/daytona,
  // @catamorphic/microsandbox, or @catamorphic/local-process
  sandboxProvider: new CloudflareSandboxProvider({
    apiUrl: process.env.CLOUDFLARE_SANDBOX_API_URL!,
    apiKey: process.env.CLOUDFLARE_SANDBOX_API_KEY,
  }),
});
await catamorphic.migrate(); // idempotent, schema-scoped

// Worker startup is explicit and host-owned.
const executionWorker = catamorphic.startExecutionWorker({ concurrency: 4 });

// Per request: bind the host's org + user
const client = catamorphic
  .forTenant({ tenantId: orgId })
  .forUser({ externalUserId: userId });
const project = await client.projects.create({ name: "Onboarding" });
const run = await client.runs.triggerProduction({
  projectId: project.id,
  workflowName: "welcomeUser",
  input: { email: "ada@example.com" },
});
```

To expose the HTTP API to your frontend:

```ts
import { catamorphicPlugin } from "@catamorphic/fastify-plugin";

app.register(catamorphicPlugin, { core: catamorphic.core, prefix: "/api" });
```

And on the frontend, wrap your tree with `CatamorphicProvider` from `@catamorphic/react` and drop in `WorkflowEditor` from `@catamorphic/ui` (or build your own UI from the hooks). See [`INTEGRATION.md`](INTEGRATION.md).

## Workflow code format

There is one public Workflow model and one public Run model: every workflow is
an exported `defineWorkflow(({ defineBoundary, defineBatch }) => ({ steps:
[...] }))` value from `@catamorphic/workflow`, and every run executes a
deployed commit.

### Boundaries and steps

A boundary is one atomic retry scope: if its callback fails, all operations in
that callback retry together. Orchestration code lives in boundary `run`
bodies; IO and business operations live in `"use step"` functions: plain
async functions with the exact `"use step"` directive, called from boundary
bodies. All functions take one destructured object parameter and carry JSDoc
display metadata.

```typescript
import { type BoundaryContext, defineWorkflow } from "@catamorphic/workflow";

/**
 * @displayname Welcome New User
 * @description Onboard a new user
 */
export const welcomeUser = defineWorkflow(({ defineBoundary }) => ({
  steps: [
    defineBoundary({
      run: async ({
        input,
      }: BoundaryContext<{ email: string; name: string }>) => {
        const user = await createUser({ email: input.email, name: input.name });
        await sendWelcomeEmail({ to: user.email, name: user.name });

        if (user.plan === "premium") {
          await assignPremiumBenefits({ userId: user.id });
        }

        await sendFollowUpEmail({ to: user.email });

        return { status: "complete", userId: user.id };
      },
    }),
  ],
}));
```

### Batch scopes

A batch scope is paged per-item processing with an optional sink. `defineBatchStep` is a
physical coalescing primitive for compatible calls inside `defineBatch.process`;
it does not define a Workflow or a separate logical step scope.

```typescript
import { defineWorkflow } from "@catamorphic/workflow";

export const processAccount = defineWorkflow(
  ({ defineBoundary, defineBatch }) => ({
    steps: [
      defineBoundary<{ accountId: string }, { accountId: string }>({
        retry: { maxAttempts: 3 },
        run: async ({ input }) => prepareAccount({ accountId: input.accountId }),
      }),
      defineBatch({
        source: async ({ input }: { input: { accountId: string } }) => ({
          source: recordsSource,
          config: { accountId: input.accountId },
        }),
        process: async ({ item }: { item: AccountRecord }) =>
          processRecord({ record: item }),
        sink: resultSink,
      }),
    ],
  }),
);
```

The parser and UI expose capabilities such as batch processing and
cancellation. There is no public stage concept, category switch, or separate
Run family for these capabilities. A workflow with no pause, retry backoff,
rate limit, batch, or child call settles inline when triggered synchronously:
inline request-response is a property of execution, not a separate authoring
form.

### Triggers

Workflows subscribe to trigger kinds in code (`triggers:
[trigger("kind", config)]`). Hosts define their own kinds with
`defineTriggerKind` (typed payloads and configs via zod, generated
`catamorphic-triggers.d.ts` per project) and fire them sync or async; a kind
whose payload varies per workflow uses typed holes, and kinds declared via
`mcpToolKinds` are served as MCP tools from `POST /projects/:id/mcp`. See
[`INTEGRATION.md`](INTEGRATION.md) and ADRs
[0039](docs/decisions/0039-custom-trigger-kinds.md) /
[0042](docs/decisions/0042-parameterized-trigger-kinds-and-workflow-tools-mcp.md).

### Long-lived journeys: correlation keys, signals, shared rate budgets

A run may carry a **correlation key**: a host-meaningful identity for its
subject (a contact, an account, a subscription). It is unique among live runs of
the same workflow, which makes it at once an enrollment idempotency key and the
address external events use to reach the run. A boundary declares the shared
third-party budgets it draws on; buckets are keyed per tenant, so every workflow
naming the same `globalKey` draws on one budget.

```typescript
export const nurtureContact = defineWorkflow(({ defineBoundary }) => ({
  controls: { cancel: true },
  steps: [
    defineBoundary({
      rateLimits: [
        { globalKey: "email", capacity: 500, refillRatePerSecond: 100 },
      ],
      run: async ({ input, pause }: BoundaryContext<{ contactId: string }>) => {
        await sendWelcomeEmail({ contactId: input.contactId });
        return pause<{ clicked: boolean }, { contactId: string }>({
          signal: "reply",
          timeout: "72h",
          state: { contactId: input.contactId },
        });
      },
    }),
    defineBoundary({
      // A different step, a different provider, a different budget.
      rateLimits: [
        { globalKey: "whatsapp", partitionKey: "sender-1", capacity: 80, refillRatePerSecond: 20 },
      ],
      run: async ({ input }) => sendWhatsApp({ contactId: input.state.contactId }),
    }),
  ],
}));
```

```ts
// Enrolling twice for the same contact is a no-op, so webhook redelivery is safe.
await client.runs.triggerProduction({
  projectId, workflowName: "nurtureContact",
  input: { contactId: "contact-42" },
  correlationKey: "contact-42",           // onConflict: "ignore" | "error" | "restart"
});

// External events address the contact, not a run id.
await client.runs.signalByKey({
  projectId, workflowName: "nurtureContact",
  correlationKey: "contact-42",
  signal: "reply", idempotencyKey: replyEventId, value: { clicked: true },
});

// Opting out ends the journey wherever it sits. Resolves null if none was live.
await client.runs.cancelByKey({
  projectId, workflowName: "nurtureContact",
  correlationKey: "contact-42", reason: "unsubscribed",
});
```

Waiting for capacity is not failure: a boundary that cannot reserve is
rescheduled without consuming a retry and without holding a sandbox. When a
provider answers with a 429, report it with `rateLimited({ retryAfterMs })`:
that blocks every workflow sharing the account, not just the run that hit it.

Hosts bound what any one tenant may consume from these shared resources via
`catamorphic.tenantPolicies`. It is SDK-only and never exposed over HTTP, so a
tenant cannot raise its own limits:

```ts
await catamorphic.tenantPolicies.upsert({
  tenantId,
  maxConcurrentJobs: 32,     // ceiling on simultaneously leased jobs
  maxActiveRuns: 50_000,     // ceiling on live runs; bounds enrollment fan-out
  queueWeight: 4,            // relative share of each claim batch
  retentionDays: 365,        // overrides the installation retention window
  rateLimitOverrides: {      // can tighten an author's bucket, never loosen it
    whatsapp: { capacity: 40, refillRatePerSecond: 10 },
  },
});
```

### Retention

Finished runs are purged after **90 days by default**, along with everything
hanging off them: jobs, events, step attempts, batch items and their steps.
Without this, a daily 100k-item batch adds on the order of 1.5M rows a day and
never gives any back.

The sweep runs inside the execution worker, so it needs no wiring. Change the
window, or turn it off entirely, at construction:

```ts
const catamorphic = createCatamorphic({
  database,
  storage,
  retention: { runRetentionDays: 30 }, // or { enabled: false } to keep forever
});
```

Individual tenants can be given a longer or shorter window with
`retentionDays` above.

See [ADR 0027](docs/decisions/0027-correlation-keys-and-external-signals.md),
[ADR 0028](docs/decisions/0028-shared-rate-budgets-and-tenant-execution-policy.md),
and [ADR 0030](docs/decisions/0030-run-retention.md).

## Local development

```bash
bun install

# Only for an explicitly provisioned host database. These are not part of the
# normal local app workflow; never point them at a database another session uses.
DATABASE_URL="<host-owned database URL>" bun run db:migrate
DATABASE_URL="<host-owned database URL>" bun run db:codegen

# Build everything
bun run build

# Regenerate the OpenAPI spec + typed api-client after route/DTO changes
cd packages/fastify-plugin && bun run generate-spec
cd ../api-client && bun run generate
```

Optional shared OTel, ClickHouse, and sandbox-bridge services run
persistently. Start them in a separate terminal only when you need them:

```bash
bun run dev:infra
```

The framework packages are embed-only. In production, run either the stock
server host or an application that boots Catamorphic in-process. For local
development, `bun run dev` starts the combined desktop and stock-server manual
environment. `bun run dev:desktop` and `bun run dev:server` are focused
variants of the same orchestrator, which assigns each worktree its own data
directories and loopback ports. To iterate on Catamorphic alongside your own
host, link the packages via `file:` (see
`.agents/skills/using-catamorphic/SKILL.md` and its "Local dev linking"
section).

## Scripts

```bash
bun install         # Install dependencies in this worktree
bun run dev         # Combined desktop and stock-server manual environment
bun run dev:desktop # Desktop-focused development environment
bun run dev:server  # Stock-server-focused development environment
bun run dev:infra   # Optional OTel, ClickHouse, and sandbox-bridge services
bun run build       # Build all packages
bun run test        # Deterministic root and Postgres-complete workspace tests
bun run test:external # Explicit opt-in for credentialed external integrations
bun run check       # 12-phase merge gate
bun run typecheck   # Typecheck all packages with tsgo
bun run lint        # Lint with Biome
bun run lint:fix    # Auto-fix lint issues
bun run db:migrate  # Apply migrations to the DB pointed at by DATABASE_URL
bun run db:codegen  # Regenerate Kysely types from the `catamorphic` schema
bun run db:reset    # Drop + recreate the catamorphic schema (dev only)
bun run db:status   # Show applied / pending migrations
```

## Testing

Tests use **Vitest**, orchestrated by Turborepo. Docker must be running:
`bun run test` and `bun run check` create an isolated disposable Postgres
database for every invocation. They do not need `bun run dev:infra`; that
command is optional shared observability and sandbox-bridge infrastructure,
not test infrastructure.

```bash
bun run test                                   # deterministic root and Postgres-complete workspace tests
bun run check                                  # 12 phases: lint, root/workspace types, build, migrations, root/workspace tests, and E2E
bun run test:external                          # explicit authority for credentialed integrations
bun run --filter @catamorphic/parser test      # one package through repository Node
bun run --cwd packages/parser test src/__tests__/parser.test.ts  # one file through repository Node
```

Each test file uses fresh temporary state and every root test invocation gets
its own Postgres database and temporary caches, so parallel worktrees do not
share test output. Install dependencies in each worktree and never copy a
credentialed `.env` wholesale. Add only the individual settings a task needs.
Root orchestration tests under `scripts/**/*.test.ts` run before the package
graph. Package-local Vitest commands also select the repository-pinned Node,
including when the ambient `node` is Node 20.

External integration tests never run merely because credentials are present.
They require the explicit `bun run test:external` authority, which sets
`CATAMORPHIC_EXTERNAL_INTEGRATIONS=1`, and skip when their service-specific
configuration is absent:

- **Daytona** (`packages/daytona`): needs `DAYTONA_API_KEY`.
- **Cloudflare Sandbox** (`packages/cloudflare`, `packages/core`): needs `CLOUDFLARE_SANDBOX_API_URL`, `CLOUDFLARE_SANDBOX_API_KEY`, and `CF_SANDBOX_INTEGRATION=1`. Start the sandbox bridge separately if the test needs it.
- **Cloudflare Artifacts** (`packages/cloudflare`): needs `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, and `CLOUDFLARE_ARTIFACTS_NAMESPACE`; it skips with a warning while feature-gated.
- **S3-compatible storage** (`packages/s3`): needs `S3_BUCKET`, `S3_ACCESS_KEY_ID`, and `S3_SECRET_ACCESS_KEY`. Set `S3_REGION` when the provider requires it, `S3_ENDPOINT` for R2, MinIO, or another non-AWS endpoint, and `S3_FORCE_PATH_STYLE=true` when that endpoint requires path-style requests.

Unit tests run with no setup. The desktop app additionally has hidden and
visible E2E suites that drive the real Electron binary over CDP with a
deterministic fake agent. Run `bun run --cwd apps/desktop test:e2e` for the
interruption-free suite and `bun run --cwd apps/desktop test:e2e:visible` for
compositor, focus, and native window behavior. `bun run check` runs both as
part of the merge gate.

The local development runner uses POSIX process groups and supports macOS and
Linux. Windows development orchestration is not supported.

## Tech stack

- **Bun**: runtime, package manager, bundler (also inside sandboxes)
- **TypeScript**: tsgo for typechecking
- **Postgres**: all state, schema-scoped; run queues, retries, pauses, and scheduling use the same DB
- **Electron + electron-vite**: the desktop reference implementation
- **Fastify**: HTTP surface with Zod + OpenAPI (mounted by the host)
- **React Flow**: workflow visualization; **Jotai** + **TanStack Query**: frontend state
- **ts-morph**: TypeScript AST parsing
- **Kysely**: type-safe SQL
- **isomorphic-git**: portable git, no native CLI dependency (system git is a soft dependency for the desktop's read surfaces)
- **OpenTelemetry**: `@opentelemetry/api` instrumentation throughout
- **Turborepo**: build orchestration

## Roadmap

Direction, not shipped. Tracked in [`TODO.md`](TODO.md):

- **Desktop distribution after the first alpha**: automatic updates, Intel
  Mac validation, then signed Windows and Linux packages.
- **ACP harness**: project agent definitions already accept `kind: "acp"`;
  the Agent Client Protocol client (local command and remote endpoint
  transports) is the planned harness behind it.
- **TS `defineAgent`**: a typed authoring layer that compiles to the
  committed `agents/<slug>.json` substrate.
- **Review-mode collaboration**: PR-first sync for shared projects, invites,
  native PR review depth (comments, approvals, merge).
- **Remote blob storage**: user-connected stores (S3/R2/Drive-style) for
  large binaries beside git-tracked text.
