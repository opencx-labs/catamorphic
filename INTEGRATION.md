# Catamorphic Integration Guide

Catamorphic is an **embeddable framework for agentic work environments**. A host mounts it in-process and gets the whole environment: general-purpose projects (git repos that hold docs, data, code, automations, and apps — ADR 0043), git-native work tracking (per-turn checkpoint commits, remote sync, the CodeHost seam — ADR 0044), multi-harness coding agents with durable sessions (ADR 0038), durable TypeScript workflows, sandboxed user-built apps (ADRs 0035–0037), and hooks that make the result look and behave like the *host's* product (ADRs 0048–0049). Workflows are one capability among these, not the frame.

A host application runs catamorphic services in-process against its own Postgres instance: all catamorphic tables live in one schema (default: `catamorphic`). Three integration surfaces are available, in increasing order of coupling:

1. **`@catamorphic/db` only**: run the migrations, let the host join against `catamorphic.projects` / `catamorphic.workflow_runs`. Read-only relationship. Useful for reporting / BI.
2. **`@catamorphic/server-sdk` (library-direct, recommended)**: host imports `createCatamorphic(...)` and calls resources in-process. Identity is bound per request via `cat.forTenant({ tenantId }).forUser({ externalUserId })`. No sidecar process.
3. **`@catamorphic/fastify-plugin` + `@catamorphic/api-client`**: host registers the Fastify plugin on its own server (or runs `createApp` as a sidecar) and frontends talk to it over HTTP. Same backing services; required for the React UI, and useful when the host is non-Node or wants a network boundary.

Most hosts use 2 + 3 together: the server-sdk boots the core once, the fastify plugin exposes it to the frontend.

For agent-guided setup, start with
[`skills/setup-work-server`](skills/setup-work-server/SKILL.md).
It inspects an existing application, auth, database, and deployment before
asking questions, then routes to stock-host or custom-host guidance.

## Host shapes: Catamorphic runs wherever TypeScript runs

Do not assume the host is a multi-tenant SaaS server. Every infrastructure
dependency is an axis with a lightweight end, and the combinations are all
supported: **Catamorphic Desktop is the existence proof for the lightest
column**: it embeds this same framework inside an Electron app with pglite
and local sandboxes, no server, no network Postgres, by design.

| Axis | Heavy end | Light end |
| --- | --- | --- |
| Database | Network Postgres (`{ pool }` / `{ connectionString }`) | **Embedded pglite**: build a Kysely instance on `PGliteDialect` and pass `database: { db }`. Migrations run statement-by-statement specifically so single-connection dialects work. |
| Execution | Cloud sandboxes (`@catamorphic/cloudflare`, `@catamorphic/daytona`) | **Local sandboxes** (`@catamorphic/microsandbox`), **plain local processes** (`@catamorphic/local-process`, trusted single-tenant hosts only — ADR 0047), or omit `sandboxProvider` entirely for read-only embeds |
| Code storage | S3-compatible bucket (`@catamorphic/s3`: R2, S3, MinIO) or Cloudflare Artifacts | Two writable directories (`projectsPath`, `remotesPath`) |
| Identity | Host org/user per request (`forTenant({ tenantId }).forUser({ externalUserId })`) | A single fixed tenant/user for single-user apps |
| Surface | HTTP API + React UI | In-process SDK calls only, or migrations-only (`@catamorphic/db`) |

Common host shapes, composed from those axes:

- **Multi-tenant SaaS**: network Postgres, cloud sandboxes, S3-compatible
  storage, identity from the host's auth. The rest of this guide's examples
  use this shape.
- **Desktop / local-first app**: pglite, local sandboxes, filesystem
  storage, fixed identity. Reference implementation:
  [`apps/desktop/src/main/server/boot.ts`](apps/desktop/src/main/server/boot.ts).
- **Single-tenant internal tool**: network Postgres the team already has
  (or pglite), **`@catamorphic/local-process` execution** — plain
  subprocesses, no cloud sandbox account, and workflows reach host-local
  services (internal APIs, a loopback database gateway) with no tunnels.
  Sound because every production run executes an immutable deployed commit
  (ADR 0040): the trust statement attaches to a reviewed deploy, not to
  whatever an agent typed five minutes ago. Never use this provider for
  multi-tenant hosts — the only isolation is a process boundary and an
  explicit env. **This shape ships ready-made as the Work server**
  (`apps/server`, ADRs 0059, 0071, 0072): `docker run` with everything on
  disk, stock Better Auth with local or configured provider sign-in,
  OAuth/PKCE remote clients, credential-free admission links, mDNS LAN
  discovery, and `DATABASE_URL` to swap PGlite for real Postgres. Read it as the
  reference for this shape before writing a host from scratch. A company that
  needs its own code runs the same server as a library
  ([`@catamorphic/work-server`](packages/work-server/README.md), ADR 0160):
  `config` is typed data validated by the image's file schemas, `hooks` are
  code, and only `workServerConfigFromEnv` reads `WORK_*` variables and files
  (ADR 0183).
- **Read-only embed / reporting**: `@catamorphic/db` migrations plus SQL
  joins, or the SDK without a sandbox provider.

## Library-direct SDK: `@catamorphic/server-sdk`

See [`packages/server-sdk/README.md`](packages/server-sdk/README.md) for the full usage guide. The short version:

```ts
// Boot, once per process
import { CloudflareSandboxProvider } from "@catamorphic/cloudflare";
import {
  createCatamorphic,
  defineStaticEnvironments,
} from "@catamorphic/server-sdk";

const sandboxProvider = new CloudflareSandboxProvider({
  apiUrl: process.env.CLOUDFLARE_SANDBOX_API_URL!,
  apiKey: process.env.CLOUDFLARE_SANDBOX_API_KEY,
});
const environmentProvider = defineStaticEnvironments([
  {
    descriptor: {
      id: "local",
      label: "Managed execution",
      trust: "managed",
      isolation: "sandbox",
      workloads: ["agent", "workflow"],
      agentTopologies: ["controller"],
      capabilities: ["network.egress"],
      resources: {},
    },
    sandboxProvider,
  },
]);

export const catamorphic = createCatamorphic({
  // Pass a pg.Pool the host already owns, or a connection string catamorphic
  // manages itself. Tables live in the `catamorphic` schema either way.
  database: { pool: hostPgPool },
  storage: {
    projectsPath: process.env.CATAMORPHIC_PROJECTS_PATH!,
    remotesPath: process.env.CATAMORPHIC_REMOTES_PATH!,
  },
  // Sandbox backends are packages the host constructs: @catamorphic/cloudflare
  // or @catamorphic/daytona in the cloud, @catamorphic/microsandbox locally,
  // or @catamorphic/local-process (trusted single tenant). Omit for read-only
  // embeds.
  sandboxProvider,
  environmentProvider,
});

// Apply pending migrations (idempotent, schema-scoped). Run from a deploy
// step or at boot. It never touches the host's own tables.
await catamorphic.migrate();

// Worker startup is explicit. Start it once when this host process should
// process queued production runs.
const executionWorker = catamorphic.startExecutionWorker({ concurrency: 4 });
// When coding agents are configured, recover queued turns and retries too.
// Defaults to current project memberships; inject resolveIdentity for host auth.
const agentWorker = catamorphic.startAgentWorker();

// Per request
const scoped = catamorphic
  .forTenant({ tenantId: req.org.id })
  .forUser({ externalUserId: req.user.id });
const project = await scoped.projects.create({ name: "onboarding" });
await scoped.files.write({
  projectId: project.id,
  path: ".work/workflows/src/welcome.ts",
  content: welcomeTs,
  commitMessage: "Add welcome workflow",
});

const run = await scoped.runs.triggerProduction({
  projectId: project.id,
  workflowName: "welcomeUser",
  input: { email: "ada@example.com" },
});
```

Advanced hosts can inject their own wiring instead: `database: { db }` with a pre-built Kysely instance, `storage: { projectManager }` with custom git backends, or a custom `sandboxProvider`. Every injected sandbox provider is automatically wrapped with OpenTelemetry instrumentation.

### Identity mapping

- `tenantId` = host's org id. Maps 1:1 to `catamorphic.tenants(id)` and is upserted on first use: hosts never need to pre-register orgs with catamorphic.
- `externalUserId` = host's stable user id. Catamorphic stores it where durable ownership, membership, or audit attribution requires it, but never references the host's user table.
- The host can freely `JOIN host.orgs.id = catamorphic.projects.tenant_id` for reports, analytics, cascading deletes, etc. Catamorphic never references host tables.

### Scoped-client surface

The scoped client exposes project CRUD, workflow listing/fetching, file I/O,
the complete identity-bound Runs resource, the Triggers resource, and
`scoped.codeHosts` (the caller's personal connection to a code host,
repository listing, repository import, and `publishProject` to a new
repository Work owns). Code hosts act through connections (ADR 0177):
register the provider and its code host,
`connectionProviders: [github]` and `codeHosts: [githubCodeHost(github)]`
with `const github = defineGithubConnectionProvider({ oauth })`. A call uses
the caller's own connection (authorized in the project, or their personal
connection from `core.connections.beginPersonalAuthorization`), else the
service connection named like the provider. An imported repository is attached
(ADR 0170): every network push passes the guard in `@catamorphic/git`, so
Work only creates `work/` branches there and shares changes as pull
requests, whichever host embeds it. Every public
method takes one keyed object parameter, for example
`scoped.projects.get({ projectId })`,
`scoped.workflows.get({ projectId, workflowName })`, and
`scoped.runs.get({ runId })`. Hosts do not pass tenant or user IDs into
individual calls. Plugin, secret, git, agent-session, and remote-sync
operations remain available through `catamorphic.core.*` and the HTTP
surface.

`scoped.runs` is the one SDK family for all Workflows. It includes run
triggering, list/detail, cancellation, operator processing pause/resume,
input submission, and item inspection. Capabilities on a Workflow or Run decide
which controls apply; there is no separate batch or persisted-continuation Run
resource.

`scoped.triggers` is the custom-trigger surface: hosts register domain trigger
kinds at boot (`defineTriggerKind` + `createCatamorphic({ triggerKinds })`),
workflows subscribe in code with `triggers: [trigger("kind", config)]`, and
the host fires a kind with a typed payload (`fire`, sync or async — sync runs
inline until the workflow's first durable wait, then detaches with an honest
`suspended` outcome), lists subscribed workflows with their constant configs
(`list`), and projects the generated `work-triggers.d.ts` into a
workspace (`syncTypes`). A trigger firing starts ordinary Runs — no new run
family. See `docs/decisions/0039-custom-trigger-kinds.md`.

Projects compose their own kinds from the host's (ADR 0171): an export of
`defineTrigger({ name, from: trigger("webhook", { ... }), where })` in
`.work/triggers/` is a kind workflows bind by name. Every binding may carry
`where`, a declarative filter over the payload (value, list of values,
`{ $exists }`, or `{ $prefix }` for strings) that core evaluates before a run
starts, on every fire path and without running project code. Session events
carry the chat's key (`payload.session.key`), so a workflow selects a family of
keyed chats with `{ $prefix: "slack:" }` (ADR 0181). At scan a project-kind binding resolves to the
host kind it builds on, with all filters along the chain; `list` reports
`kind` (the host kind), `where`, and `projectKind`. Codegen adds project kinds
to `work-triggers.d.ts`, so `syncTypes` needs nothing from the host.

Project Events (webhooks, chat events, polled sources such as a desktop's
GitHub poller registered in `projectEventSources`) reach workflows through the
event dispatcher. Start it once per server, whether or not coding agents are
configured, and stop it on shutdown:

```ts
import { startEventDispatcher } from "@catamorphic/core";
const events = startEventDispatcher({ core: catamorphic.core });
// on shutdown: await events.stop();
```

Directory events (ADR 0209) are Project Events about a whole tenant: register
`DIRECTORY_TRIGGER_KINDS` from `@catamorphic/server-sdk`, and when an account
joins, leaves, or changes groups, build
`directoryProjectEvent({ kind, member, groups, occurredAt, revision })`,
record it with the change, and once that commits deliver it with
`core.projectEvents.appendToSubscribers({ tenantId, ...event })`, retrying
until it succeeds: a failed delivery must never undo the change (a departed
member stays disabled). Only projects with an active automation of that kind
store it; `revision` counts the account's transitions, so a replay is stored
once, and delivering one account's events in revision order keeps a join
from arriving after the departure that followed it. A kind may require permissions of
the workflows that bind it (`defineTriggerKind({ requiredPermissions })`);
these require `memberships:read`, enforced at scan and by the project check.
The Work server does all of this for every `DirectoryProvider`.

Webhooks are a built-in trigger kind: register `webhook` from
`@catamorphic/server-sdk` in `triggerKinds`, and pass `publicApiBase` (the
public URL of the mounted API, including its prefix) to `catamorphicPlugin` or
`createApp` so the webhook URLs people copy point at the reachable host.
`POST <api>/hooks/:projectId/:name/:token` is public; the token and the
binding's declared `verify` are its credential: `hmac` (algorithm, header,
prefix, encoding, a signed-content template over `{body}`, `{timestamp}` and
`{header:<name>}`, a replay window, base64 keys) or `token` (a shared secret in
a header or query parameter), each naming a project secret. Declared `respond`
rules answer handshakes (Slack `url_verification`, GET `hub.challenge`) with
200 and the echoed value, which is why the same path also accepts `GET`;
anything else is stored and answered 202. A sender's retry is stored once,
identified by its delivery-id header or by the binding's `deliveryId`, a value
the sender repeats in the body (`"body.event_id"` for Slack, ADR 0179). Bodies are capped at 1 MiB unless a
binding sets `maxBodyBytes`, up to the host maximum
`createCatamorphic({ webhooks: { maxBodyBytes } })`. Holders of
`webhooks:read` list URLs with `GET <api>/projects/:projectId/webhooks`, and
holders of `webhooks:write` rotate one with
`POST <api>/projects/:projectId/webhooks/:name/rotate`. See ADRs 0156 and 0171.

Enablements belong to a member or to the project (`owner: { type: "project"
}`). A project enablement runs as the project principal with shared
connections. Workflows reach chats with one operation,
`catamorphic.sessions.deliver`, naming the chat by `sessionId` or by a `key`
that starts the chat on first use; a project automation's keyed chats are
project chats every member of the agent's role sees (`AgentSession.owner ===
"project"`), or one member's with `audience: { member }`.

A workflow that acts beyond its own caller declares the project permissions
its runs need: `defineWorkflow(({ defineBoundary }) => ({ permissions:
["sessions:read", "sessions:write"], steps: [...] }))`. A run holds only the
declared permissions its caller also holds. Only someone holding every
declared permission can turn the workflow on, and the consent lists them. A
member's automation keeps them only while the member does; a lost permission
suspends it with `permission_revoked`. A project automation, turned on by a
holder of `automations:write`, runs as the project principal with the
consented permissions. That is how a permitted workflow lists other people's
chats (`sessions:read`) or delivers into them by `sessionId`
(`sessions:write`). See ADR 0158.

### Observability

Catamorphic libraries use only the OpenTelemetry APIs (`@opentelemetry/api`
and `@opentelemetry/api-logs`). Register your own tracer, meter, and logger
providers and choose any exporters, processors, samplers, resources, or views.
Libraries do not initialize SDKs, read exporter environment variables, or take
ownership of your providers. Without providers, instrumentation is a no-op.
The optional `@catamorphic/otel/node` entry point provides the shipped hosts'
NodeSDK bootstrap and accepts the complete `NodeSDKConfiguration` for embedders
who want it. SDK/exporter dependencies are optional peers, required only by that
entry point. See [OBSERVABILITY.md](OBSERVABILITY.md) for configuration, coverage,
project routing, signal conventions, and the local collector.


## Database-only setup (just run the migrations)

Use the DB-only path when the host just wants to reach into catamorphic's schema (reporting, BI) without running catamorphic services.

Install `@catamorphic/db` in the host and run migrations as a deploy step:

```bash
DATABASE_URL=postgres://<user>:<password>@<host>:5432/<hostdb> \
CATAMORPHIC_DB_SCHEMA=catamorphic \
npx catamorphic-db migrate     # or: catamorphic-db status
```

Or programmatically:

```ts
import { createDatabase, migrateToLatest } from "@catamorphic/db";

const db = createDatabase({ pool: hostPgPool });
await migrateToLatest({ db, schema: "catamorphic" });
```

For local development against a catamorphic checkout, install via `file:` links and rebuild after changes: see `.agents/skills/using-catamorphic/SKILL.md` → "Local dev linking".

## HTTP path: `@catamorphic/fastify-plugin`

Register the plugin on the host's Fastify server, telling it who is calling:

```ts
import { catamorphicPlugin } from "@catamorphic/fastify-plugin";

app.register(catamorphicPlugin, {
  core: catamorphic.core,
  prefix: "/api", // the generated api-client expects /api
  // The one identity mechanism. Runs on every request (including iframe
  // navigations to served app documents, which carry your session cookie).
  identity: async (request) => {
    const session = await verifySession(request); // your auth
    if (!session) return null;                     // → 401
    return { tenantId: session.orgId, externalUserId: session.userId };
  },
});
```

The plugin is fully encapsulated (its Zod compilers and error handler don't leak into the host app) and registers no CORS: the host owns cross-origin policy. For a sidecar process or spec generation, `createApp({ core, identity })` returns a complete Fastify app with CORS + Swagger UI at `/docs` and the plugin mounted at `/api`.

**There is no default identity.** The `identity` resolver is required and the plugin reads no headers on its own. Hosts whose auth terminates *in front of* the plugin (a gateway or proxy route that already verified the session) can pass the stock header resolver, `identityFromHeaders()`, which reads `X-Catamorphic-Tenant-Id` (host org id) and `X-External-User-Id` (host user id) — but a plugin mounted with it must never be reachable by browsers directly, since anyone could then claim any identity.

### Root and scoped identities: artifacts and permissions

An identity is either **root** (`scope` absent: every project of the tenant, every surface, every permission: the desktop's own local projects, a host's service identity) or **scoped**. A scoped identity carries two lists: `scope`, the artifacts it may use, and `projectPermissions` (`[{ projectId, permission }]`), what it may do to the project beyond using them. Refs name artifacts by `(projectId, name|path)`; an `app`, `workflow` or `agent` ref may name `"*"` for every one of that kind:

| Ref | Grants |
| --- | --- |
| `{ kind: "app", projectId, name }` | The app's served document plus, transitively, the workflows frozen into its *active published* version. |
| `{ kind: "workflow", projectId, name }` | One workflow directly (a per-customer MCP tool, a host-triggered action). |
| `{ kind: "agent", projectId, name, toolPolicies? }` | Chat sessions on the committed project agent `.work/agents/<name>.json` (ADR 0050). Inside those sessions the caller's scope intersects the agent's tool policy: the project's tools server is narrowed to the caller's workflow refs, and `toolPolicies` (per connector server key, ADR 0054's shape) is one more narrowing layer. Own sessions only. |
| `{ kind: "document", projectId, path, access? }` | A file (`docs/handbook.md`) or subtree (`store/customers/acme/**`) of the project's path namespace; `access` defaults to `read`, `write` implies read. Git paths are read-only through this ref; `store/…` paths are the project store, reachable ONLY through document refs, whatever permissions the identity holds. |

```ts
identity: async (request) => {
  const session = await verifySession(request);
  if (!session) return null;
  const base = { tenantId: session.orgId, externalUserId: session.userId };
  if (session.isAdmin)
    return {
      ...base,
      scope: [
        { kind: "agent", projectId: BRAIN, name: "*" },
        { kind: "workflow", projectId: BRAIN, name: "*" },
        { kind: "app", projectId: BRAIN, name: "*" },
      ],
      projectPermissions: [{ projectId: BRAIN, permission: "*" }],
    };
  // A CSM: the CSM agent, its workflows, and their own customers' subtree.
  return {
    ...base,
    scope: [
      { kind: "agent", projectId: BRAIN, name: "csm-assistant" },
      { kind: "workflow", projectId: BRAIN, name: "crm.lookup" },
      ...session.customers.map((c) => ({ kind: "document", projectId: BRAIN, path: `store/customers/${c}/**`, access: "write" })),
    ],
  };
}
```

Project permissions are `thing:action`. Catamorphic enforces these:

| Thing | `read` | `write` | `publish` |
| --- | --- | --- | --- |
| `program` | source, history, definitions | edit the working copy, branches, app builds | make it live: deploy, plugins, app versions, rename |
| `secrets` | which secrets exist | set and delete values | |
| `automations` | everyone's automations | turn project automations on, pause, update | |
| `webhooks` | webhook URLs (credentials) | replace them | |
| `runs` | everyone's runs | cancel, pause, resume, signal anyone's | |
| `sessions` | everyone's chats | deliver into, interrupt, archive anyone's | |
| `memberships` | the member list | invite, grant, revoke | |
| `roles` | the role files | change them; assign roles that carry permissions | |
| `publications` | everyone's publications | revoke anyone's | |

`write` and `publish` each imply `read` on the same thing; nothing else implies anything, so `program:publish` does not include `program:write`. A grant may be `thing:*` or `*`. Deleting a project is a tenant operation for the root identity only.

Which artifacts and permissions each user gets is host policy (a role file, an entitlement table); catamorphic only enforces the result. Enforcement lives in core, so `server-sdk` callers get it too: `catamorphic.forTenant({ tenantId }).forUser({ externalUserId, scope, projectPermissions })`. Scoped agent sessions hand host hooks the caller (`AgentTurnContext.caller`, also on `ExtraToolContext.caller`) and the harness the caller's policy layers (`AttemptStart.toolPolicies`, read again at every attempt): a hosting backend uses `caller` in `harness.mcpServers(context)` to mint the project MCP endpoint's credentials for that user, so the endpoint enforces the same scope structurally. See [`docs/decisions/0053-identity-scope-and-app-routes.md`](docs/decisions/0053-identity-scope-and-app-routes.md) and [`0055`](docs/decisions/0055-company-brain-roles-store-and-change-loop.md).

### Roles as files, memberships as the stock source (ADR 0055)

Most hosts do not want to hand-write scopes. Commit roles into the project — `.work/roles/<slug>.json`, next to `.work/agents/` — and let core expand them:

```jsonc
// .work/roles/csm.json
{
  "version": 1,
  "name": "CSM",
  "agents": ["csm-assistant"],                       // or { "name", "toolPolicies": { "slack": { "default": "ask" } } }
  "workflows": ["crm.lookup", "docs.search"],
  "apps": ["customer-tracker"],
  "documents": ["docs/**", { "path": "store/customers/{customer}/**", "access": "write" }]
}
// .work/roles/admin.json
{ "version": 1, "name": "Admin", "agents": ["*"], "workflows": ["*"], "apps": ["*"], "environments": ["*"], "permissions": ["*"], "documents": ["store/**"] }
// .work/roles/brain-maintainer.json
{ "version": 1, "name": "Brain Maintainer", "permissions": ["brain:maintain"], "agents": ["brain-maintainer"] }
```

`{param}` placeholders are filled from per-user **grants** (`{ customer: ["acme", "globex"] }`), one ref per value; an entry whose placeholder has no grant yields nothing. `permissions` become the identity's `projectPermissions`; an admin who may not see the whole store simply lists fewer documents. Writing, committing or publishing any `.work/roles/*.json` needs `roles:write`, whoever made the edit. Role files are read from the shared origin `main` (a project without a remote reads its working tree), cached per published commit (every resolve reads the current one, so a deploy applies on every replica at once, ADR 0193), and never throw: a broken file is reported by `GET /projects/:id/roles` and contributes nothing.

Two ways to turn a verified user into an identity:

```ts
// 1. You keep roles/grants yourself (a table, an SSO claim):
identity: async (req) => {
  const u = await verifySession(req);
  return u && resolveRoles(catamorphic.core, { tenantId: ORG, projectId: BRAIN, externalUserId: u.id, roles: u.roles, grants: u.grants });
}
// 2. The stock memberships table (core.memberships) keeps them:
identity: async (req) => {
  const u = await verifySession(req);
  return u && catamorphic.core.memberships.identityFor({ tenantId: ORG, projectId: BRAIN, externalUserId: u.id });  // null = not a member
}
// An invite is one call (needs memberships:write), plus whatever link you send:
await catamorphic.core.memberships.grant({ identity: adminIdentity, projectId: BRAIN, externalUserId: "alice", roles: ["csm"], grants: { customer: ["acme"] } });
```

The plugin serves the same as HTTP for project administration: `GET /projects/:id/roles`, `GET|PUT|DELETE /projects/:id/memberships[/:externalUserId]` (`PUT` body `{ roles, grants? }`). Members arriving with a bearer credential from the host's login flow use `identityFromBearer(verify)`: the host's `verify(token)` returns the identity (typically via `memberships.identityFor`) or `null`. Every request re-resolves membership, so revocation is immediate.

Role `permissions` are an extensible, namespaced vocabulary. Core enforces
the `thing:action` names in the table above; an embedder may define and
enforce names such as `acme:approve_deals`. Unknown names do not grant
framework authority by themselves, but are preserved in identity and `GET /me`
for host services and project-owned presentation. Desktop projects can target
sidebar sections, custom items, and New Tab starting actions with
`when: { permissions: string[] }`; every listed permission must be held. Use
`permissions: ["program:write"]` for the people who edit the program. Omit
`when` to show an item to everyone.

In the desktop reference host, shared sidebars and palette modes live in
`.work/workspace.js`. New Tab actions live in the ordinary project
manifest and remain visually absent when omitted:

```json
{
  "startingActions": [
    {
      "label": "Review onboarding",
      "prompt": "Review the onboarding system and propose improvements.",
      "agent": "brain-maintainer",
      "when": { "permissions": ["brain:maintain"] }
    }
  ]
}
```

The desktop accepts at most six valid actions. `label`, `prompt`, and optional
`agent` are presentation/input only; `when` is evaluated against trusted
`GET /me` authority. This is a desktop host contract, not workflow logic or a
stock-server bootstrap file.

### Feature switches and introspection

Scope is how a host says "may not"; a few coarse switches say what the whole instance offers: `app.register(catamorphicPlugin, { …, features: { publications: "public" | "members" | false, proposals, mcp, storeUploadMaxBytes } })`. They are enforced by the routes concerned (403 / 404 / 413) *and* advertised on **`GET /me`**, together with the caller's own summary (`{ version: 1, identity: { externalUserId, root }, projects: [{ projectId, source, permissions, agents, workflows, apps, documents: [{ path, access }], roles }], features: { publications, proposals, proposalsOpenPullRequests, mcp, agentSessions, storeUploadMaxBytes } }`), so a client (the desktop, a member's own agent) shows what is possible instead of discovering it by 403. `permissions` are effective: wildcards and implications expanded. `source` contains the Git remote and default branch for holders of `program:read` and is `null` for other members.

**Remote login.** Connect links are credential-free locators: `work://connect?server=…&project=…&invitation=…`. A compatible host publishes OAuth protected-resource and authorization-server metadata. The desktop and PWA dynamically register public clients, use authorization code with S256 PKCE, keep refreshable credentials in local protected storage, and redeem admission after sign-in. A 401 changes the connection state to "Sign in again" and reruns the same OAuth path. Embedders may implement that contract with their existing identity system; Catamorphic's framework packages remain auth-neutral.

### Agent sessions: an event log of turns (ADRs 0197, 0198)

A session holds turns; a turn holds attempts; items are the ordered
transcript (messages, reasoning, tool calls, commands, file changes, plans,
requests, subagents, notices); runtime requests are questions, approvals and
elicitations; provider threads are the harnesses' native conversations. Every
change is an event in the session's gapless log, committed with the rows it
changes, so a client folds the same history wherever it reads it. The types
and the pure reducer are `@catamorphic/agent-protocol`.

- `GET /projects/:id/agent/sessions/:sid` returns the session with a bounded
  `snapshot` (recent turns, their items, open requests, threads) and its
  `sequence`; `GET .../items?before` pages older items.
- `GET .../events?after=<sequence>` streams events over SSE (`events`,
  `reset` with a fresh snapshot when the gap is too large, `heartbeat`).
  Fold them with `applySessionEvents`; resume from the last sequence.
- `POST .../commands` takes one `SessionCommand` (`send` with `dispatch:
  queue | steer | interrupt`, `interrupt`, `retry`, `edit_queued`,
  `cancel_queued`, `send_now`, `respond`, `rollback`) with a client-made
  `commandId`; sending it again returns its first receipt.

Agents are `RegisteredCodingAgent`s whose `harness` is either `{ placement:
"host", adapter }` (a `HarnessAdapter` such as `createClaudeCodeAdapter`,
`createCodexAdapter` or `createAiSdkAdapter`, run in this process, beside a
checkout on this machine or driving a sandbox through its tools) or `{
placement: "sandbox", id }` (the bundled runner runs the CLI inside the
session's sandbox). A turn whose machine went away is recovered by any
replica: its runner is reattached when it survived, otherwise the attempt is
lost and a continuation turn resumes the native thread (`recovery:
"continue"`, the default).

### Agent session lifecycle and delegation

Agent sessions carry source provenance, hierarchy, fork lineage, presentation,
archive, attention, activity, todo, and authority state in one generated
schema. `parentSessionId` is immediate hierarchy;
`forkedFromSessionId` is transcript lineage. First-class subsessions are
ordinary child sessions created through explicit delegation routes, with
create/list/wait/interrupt endpoints under the parent session. A native
harness subagent is only an execution optimization when it preserves these
durable identities and policies.

Archive is a recursive server operation, not a local hidden flag. It reports
the session ids, running work, Watchers, and processes that would stop and
returns `409 archive_confirmation_required` until the caller confirms when
necessary. Unarchive restores navigation. React hosts use `useArchiveAgentSession`,
`useUnarchiveAgentSession`, and
`useAcknowledgeAgentSessionAttention` instead of hand-written state.

### The project MCP endpoint: bring your own agent

`POST /api/projects/:id/mcp` serves the caller's whole scope as one MCP server: the project's `mcpToolKinds` workflow tools (roster filtered to the caller's workflow refs), `documents_list/read/search/write/delete/history` (the documents surface, per the caller's document refs; `documents_write` takes `text` or `base64` for binaries), `publish_document/revoke_publication/list_publications`, `propose_change`, `list_skills/read_skill`, and `ask_agent` (a synchronous turn with a project agent the caller may open sessions on). Claude Code, Cursor, or the host's own assistant connect with a host-issued token through `identityFromBearer`; the desktop's harnesses mount the same URL on every turn through their harness's `mcpServers(context)` hook. Being invited *is* receiving this URL.

The generated HTTP client lives in `@catamorphic/api-client`; construct it with `createApiClient({ baseUrl, fetch })`.

All execution uses one Runs route family:

- `POST /api/projects/:projectId/workflows/:name/runs` triggers a Run (async; returns the Run).
- `POST /api/projects/:projectId/workflows/:name/calls` **calls** a workflow synchronously: the run is driven inline until it settles or reaches a durable wait, and the response is `{ status: "completed", output } | { status: "failed", error } | { status: "suspended", runId, suspendedOn }` — poll `runId` in the last case. Sync is a calling mode, not a workflow kind: same durable run record, same deployed commit.
- `GET /api/projects/:projectId/workflows/:name/runs` lists Runs.
- `GET /api/runs/:runId` and `/api/runs/:runId/*` expose detail and capability-specific controls.

Apps have their own execution routes — `POST /api/projects/:id/apps/:name/calls/:workflow`, `POST …/apps/:name/runs/:workflow`, `GET …/apps/:name/runs/:runId` — which the `AppMount` component uses. The URL names the app, so the plugin narrows whoever arrives to that app structurally (an admin is confined to the app while inside it; a viewer must be entitled to it) before the server re-authorizes against the frozen workflow set. Nothing is claimed by the client.

Every Run executes an immutable deployed commit and retains that provenance;
there is no mutable-source or test mode.

## React bindings: `@catamorphic/react`

`@catamorphic/react` is the headless UI layer: a `CatamorphicProvider`, jotai atoms, and TanStack Query data hooks over `@catamorphic/api-client`. It has zero smart components: wire it up once and call the hooks from your own screens (or from `@catamorphic/ui`).

Peer deps: `react ^18.2 || ^19`, `react-dom ^18.2 || ^19`, `@tanstack/react-query ^5`.

```tsx
import { createApiClient } from "@catamorphic/api-client";
import { CatamorphicProvider } from "@catamorphic/react";
import { QueryClient } from "@tanstack/react-query";

const queryClient = new QueryClient();
const apiClient = createApiClient({
  baseUrl: process.env.NEXT_PUBLIC_CATAMORPHIC_URL!,
  fetch: async (input, init) => {
    // Same origin as your API: the session cookie rides along and the
    // plugin's `identity` resolver turns it into a catamorphic identity.
    return fetch(input, { ...init, credentials: "include" });
  },
});

export function Root({ children }) {
  return (
    <CatamorphicProvider apiClient={apiClient} queryClient={queryClient}>
      {children}
    </CatamorphicProvider>
  );
}
```

Then anywhere under the provider:

```tsx
import {
  useCreateProject,
  useProject,
  useProjects,
  useWorkflow,
  useWriteProjectFile,
} from "@catamorphic/react";

function ProjectList() {
  const { data } = useProjects();
  const createProject = useCreateProject();
  // …
}
```

Hooks shipped:

- **Projects + workflows + files**: `useProjects`, `useProject`, `useCreateProject`, `useUpdateProject`, `useDeleteProject`, `useProjectFiles`, `useProjectFile`, `useWriteProjectFile`, `useWorkflows`, `useWorkflow`.
- **Runs**: `useRuns`, `useRun`, `useTriggerRun`, `useCancelRun`, `usePauseRunProcessing`, `useResumeRunProcessing`, `useSubmitRunInput`, `useRunItems`, `useRunItemSteps`.
- **Git**: `useProjectGit`, `useProjectCommits`, `useProjectConflicts`, `useCommitChanges`, `useDeployProject`, plus the composite `useProjectGitState({ projectId, baselineFiles })` for client-side draft persistence.
- **Plugins + secrets**: `usePluginCatalog`, `useProjectPlugins`, `useAttachPlugin`, `useDetachPlugin`, `useProjectSecrets`, `useUpsertProjectSecret`, `useDeleteProjectSecret`.
- **Agent sessions**: `useAgentSessions`, `useAgentSession` (the live session: snapshot, event stream, resume, gap recovery), `useAgentChat` (turns, queue, requests and every session command), `useCreateAgentSession`, `useAcknowledgeAgentSessionAttention`, `useArchiveAgentSession`, `useUnarchiveAgentSession`; `sessionTimeline` reads a session as turns of input, work and answer.
- **Workflow enablement**: `useWorkflowEnablements`, `usePreviewWorkflowEnablement`, `useCreateWorkflowEnablement`, `useUpdateWorkflowEnablement`.

All hooks reject with the typed `CatamorphicError` envelope (discriminated by `code`: `unauthorized`, `forbidden`, `not_found`, `conflict`, `validation`, `rate_limited`, `sandbox_unavailable`, `authentication_required`, `network`, `unknown`). Check `err instanceof CatamorphicError` and switch on `err.code`; never branch on `err.message`. Shared OpenAPI-derived domain types (`Project`, `Run`, `RepoStatus`, `BranchInfo`, `ConflictEntry`, `PluginInfo`, `Secret`, `AgentSession`, …) live behind a single `@catamorphic/react/types` barrel.

## Agent tool permissions for hosts (ADR 0054)

Coding-agent harnesses gate every MCP tool call through a permission policy
(`allow` / `ask` / `deny`; `auto` = read-only tools run, others ask). A host
supplies two things:

- **Policies**: per server key, as layers that intersect (strictest wins).
  A host agent's `harness.toolPolicies()` (read at every attempt) and
  `RegisteredCodingAgent.toolPolicies` give the host's and the agent's
  layers; core adds the caller's. A shared org credential's ceiling is simply
  the first layer, the user's own policy the second, the agent's the third.
  The runner applies them to every tool call, in every harness (ADR 0198).
- **The answer to `ask`** (ADR 0197): an ask is a runtime request on the
  session's working turn (`kind: "approval"`), in the session snapshot and
  its event stream like any other change. Any client answers it on any
  replica with a `respond` command:
  `POST /projects/:id/agent/sessions/:sid/commands` with
  `{ type: "respond", commandId, requestId, response: { kind: "approval",
  decision: "approved" | "denied", remember?: "always" } }`. Questions and
  elicitations answer the same way. Persisting an "always allow" is the
  host's job, through `onToolAlwaysAllowed({ agentId, server, tool })`: it
  knows where the connection's policy lives.
- **Unattended chats** (ADR 0176): an approval in a project chat, or in one a
  workflow delivered with `approvers: { members, roles }`, opens with those
  people as its `approvers`: they get an `approval_requested` notification,
  the chat is promoted in their list, and only they may answer it (they need
  no other access to the chat). It waits the Environment's
  `approvals.waitMinutes` (default 30 minutes; five in a person's own chat)
  and then denies with a `reason` the agent reads. With nobody to approve it
  is refused at once, with a reason. Role holders come from stock
  memberships; hosts with their own directory name members.

Core also applies a committed definition's `toolPolicies` (keyed by
connection alias or `catamorphic`) as the agent's layer on every host, and
enforces its `sandboxing` at the control plane (ADR 0182): a `contained`
session's changes never leave its sandbox, it cannot push through the
gateway, and only read connection actions run
(`ConnectionProvider.readOnly(action)`, else the action's `readOnlyHint`); a
`propose` session may not invoke capabilities marked `sandboxing: "publish"`.
`RegisteredCodingAgent.sandboxing` and `.toolPolicies` carry the same for
agents a host defines itself. A definition's `harnessPermissions` (Claude
Code `permissionMode`; Codex `sandbox` and `approvals`) reach the harness as
`AttemptStart.permissions` on every attempt, over the agent's own options.

## Ready-made components: `@catamorphic/ui`

`@catamorphic/ui` ships the workflow canvas (`WorkflowEditor`, `WorkflowCanvas`), member workflow review and consent, the Runs panel, and `AppMount` as composable React components built on `@catamorphic/react`. Everything is opt-in: use `WorkflowEditor` for the full experience, or compose `WorkflowCanvas` + your own chrome. Hosts supply their own inspector (`renderInspector`) and code editor, linked to the canvas with `useCodeEditorLink`. Import `@catamorphic/ui/styles.css` once.

`AppMount` also accepts `display={{ mode: "compact", visible }}` and
`viewportHeight={320}` for sidebar/widget slots. The same app bundle, storage,
theme tokens and authorization apply. Visibility changes are sent without
reloading the iframe. Guests import `subscribeDisplay` from `@catamorphic/app`
to adapt their presentation and suspend optional refresh work while hidden;
the returned function unsubscribes. Layout and default widget choices belong
to the host. Compact mounting never grants workspace or Electron access.


For Tailwind hosts, import the UI stylesheet from the **same CSS entry** as
Tailwind so its packaged component classes are included:

```css
@import "tailwindcss";
@import "@catamorphic/ui/styles.css";
```

A separate JavaScript stylesheet import does not register these class sources
with the host's Tailwind compilation. Shared controls use the host's theme tokens;
headless hooks remain independent of Tailwind.

## Component registry: `@catamorphic/registry`

`@catamorphic/registry` is a shadcn-style copy-paste registry for hosts that want to own the component source. Items are JSON manifests that inline their React component files; consumers run `npx shadcn add <path-or-url>/r/<item>.json` and the component drops into `components/catamorphic/`. The component then imports hooks from `@catamorphic/react` and primitives from `@catamorphic/ui` only: there's no runtime dependency on the registry itself.

Items shipped: `catamorphic-provider`, `project-editor`, `file-explorer`,
`git-panel`, `diff-drawer`, `runs-panel`, `plugins-settings`, `monaco-editor`,
`agent-chat`, `agent-question-panel`, `chat-queue`, `chat-timeline`,
`code-review`, `resource-preview`, `sessions-list`, `todo-progress`, and
`tool-permission-card`.

Catamorphic doesn't host the registry itself. After `bun run build`, the built manifests live at `packages/registry/dist/r/<name>.json`; hosts install them from `./node_modules/@catamorphic/registry/dist/r/<name>.json` or from a URL the host serves. To add a new item: drop a `src/<name>/<name>.tsx` + `registry-item.json` under `packages/registry/src/`, run `bun run build`, and re-install it in the host.

## Plugin packages (workflow SDKs)

Catamorphic can attach external packages (for example workflow SDKs) to a project so workflows can `import` plugin exports.

In v1, plugins are resolved from a local directory configured via env:

```bash
CATAMORPHIC_LOCAL_PLUGINS_DIR=/path/to/host/plugin/packages
```

Runtime summary:

1. Server loads attached plugins and secret values for the project.
2. Plugin files are mirrored into sandbox `node_modules/<packageName>/`.
3. Secrets are injected into the harness env for plugin runtime usage.
4. Agent and workflow-builder context include plugin README + d.ts.

For full details (manifest contract, REST API, service internals, runtime flow, troubleshooting, and resolver roadmap), use [`packages/plugins/README.md`](packages/plugins/README.md) as the canonical source.

## Capabilities, lifecycle hooks, and plugin host halves (ADR 0046)

A plugin has **two activation planes**. Its *sandbox half* (client library,
manifest, docs) is attached per project through the catalog — a UI action.
Its *host half* (code that runs in the host process) activates **only by
boot registration** in `createCatamorphic`. A UI click can never execute
code in the host process.

Run-time env resolves through one bindings chain:
**capability provider → stored secret → manifest default.**

- A plugin manifest declares `requires: [{ "name": "acme.database" }]`.
- The host registers a **capability provider** for that name. At run
  launch, `resolve(...)` returns env values that are merged into the run's
  environment and never persisted — mint short-lived, per-project
  credentials here.
- Attaching a plugin whose non-optional requirement has no registered
  provider fails closed with a 400 at attach time.
- **Project lifecycle hooks** provision per-project infrastructure:
  `onProjectCreated` failures roll the create back; `onProjectDeleted` runs
  before deletion and a failure aborts it (retryable, nothing leaks). Hooks
  must be idempotent.

```ts
import {
  createCatamorphic,
  defineCapability,
  definePlugin,
} from "@catamorphic/server-sdk";

// Ships in the same npm package as the plugin's sandbox half.
const acmeDbPlugin = (cfg: { apiKey: string }) =>
  definePlugin({
    name: "@acme/catamorphic-db",
    capabilities: [
      defineCapability({
        name: "acme.database",
        resolve: async ({ projectId, environment }) => ({
          DATABASE_URL: await mintScopedUrl(cfg.apiKey, projectId, environment),
        }),
      }),
    ],
    projectHooks: {
      onProjectCreated: ({ project }) => provisionDb(cfg.apiKey, project.id),
      onProjectDeleted: ({ project }) => dropDb(cfg.apiKey, project.id),
    },
  });

export const catamorphic = createCatamorphic({
  database: { pool: hostPgPool },
  storage: { projectsPath, remotesPath },
  environmentProvider,
  plugins: [acmeDbPlugin({ apiKey: process.env.ACME_KEY! })],
  // Loose providers/hooks can also be passed directly:
  // capabilityProviders: [...], projectHooks: [...],
});
```

Workflow code stays vendor-blind — it imports the plugin's client and reads
`process.env.DATABASE_URL`. Providers must not return `CATAMORPHIC_`-prefixed
names, and duplicate capability or trigger-kind names across plugins fail at
boot.

### Caller-bound host functions and the documents surface (ADR 0055)

A capability provider may also expose **calls** — host functions a workflow
reaches as `context.host.<capability>.<fn>(args)`. Runs are stamped with the
identity that triggered them (`workflow_runs.caller_scope`); a boundary that
returns a host call ends there, core executes the function **as that
caller** (`{ caller, projectId, runId, workflowName }` is the first
argument — a workflow cannot claim to be anyone), and the result is the next
step's input, exactly like `callWorkflow`. A throw fails the step; the
step's retry policy re-runs the call (at-least-once, like any step IO).

```ts
defineCapability({
  name: "acme.crm",
  calls: {
    lookupAccount: async ({ caller }, args: { id: string }) =>
      crm.accounts.get(args.id, { asUser: caller.externalUserId }),
  },
});
// in a workflow:
defineBoundary({ run: ({ input, host }: BoundaryContext<{ id: string }>) => host.acme.crm.lookupAccount({ id: input.id }) }),
defineBoundary({ run: ({ input }: BoundaryContext<{ name: string }>) => ... }),
```

`context.documents` is the first built-in such capability: `list`, `read`,
`write`, `delete`, `history`, `search` over the project's one path
namespace — the program (git, read-only) and the project store (`store/…`,
versioned, caller-stamped) — every operation narrowed to the caller's
document refs. That is what makes project-authored search safe by
construction: an indexer or ranker that reads through `context.documents`
cannot leak what the caller may not see. `context.caller` (`{
externalUserId, scope? }`) is available for anything else that needs to
know who asked. The same surface is served over HTTP at
`/projects/:id/documents` (list, `content` JSON, `raw` bytes, `PUT` text or
base64 with `ifVersion`, `history`, `search?q=&mode=grep|text&prefix=`).
Store bytes live inline in Postgres unless `documentBlobStore` (a
filesystem or S3-compatible store) is configured; metadata, versions, text
and the search index always stay in the database. On a hosting backend,
agents' `store/` writes in their working folder are **pulled before and
shipped after every turn as the caller** (`storeSyncAroundTurns`, default
on; the turn's message metadata carries `storeSync` with what shipped, was
refused, or conflicted) — a member's agent can only land what the member
may write. Hosts whose folders are the truth (the desktop's local projects)
set it `false` and sync explicitly. The framework's
`searching-documents` host skill carries the recipe agents follow.

### Local checkouts and document storage (ADR 0104)

A desktop-style host opts into native Git with
`storage: { projectsPath, remotesPath, projectPathResolver, localCheckouts: true }`.
Register a canonical checkout path before creating its project, passing the
reserved `id` and `importExisting: true`. Import only attaches an existing Git
repository. Initialize a plain folder separately with the user's consent.
No files, seeds, commits, dependency installs, or history copies occur at import.
The host controls automatic checkpoints through `nativeAgentCheckout.checkpoint`;
attached checkouts should return `null` unless a commit was explicitly requested.

On local checkouts, `store/` files and the documents API share one working folder.
Outside edits are indexed on document reads, listing, or search. Binary bytes are
preserved, version reads remain available, and `ifVersion` detects newer edits.
Root-local program reads see current files; scoped program reads use the published
commit. Never expose a root-local bearer token as a scoped remote connection.

`GET /projects/:id/documents/storage` and the `documents_storage` MCP tool describe
whether writes land on the device or the server and whether a blob backend is
configured. A remote MCP write saves on that server. To keep a draft on a device,
use its local connection. Saving, selected document upload, and a Git commit are
separate actions. `shipRemoteProject(root, client, { paths })` uploads only those
paths; a conflict also requires `resolveConflicts` naming the chosen local versions.
Desktop per-turn store upload remains disabled.

Provide `documentBlobStore: new FsBundleStore(documentBlobDirectory)` for disk
storage, or an `S3ObjectStore` constructed by the host for S3-compatible storage.
Both implement `get`, `put`, and `deletePrefix`. Store metadata, version history,
small text, and search indexes remain in Postgres; binary payloads go to that
backend. Omitting it keeps bytes in Postgres. The desktop and stock server configure filesystem blob storage automatically
under their own data directories. Back up the database and blob directory/bucket together.
Changing backends requires migrating existing blob keys; missing objects produce
an explicit load failure, never an empty document. Keep bucket credentials on the
host, outside project files. Scoped document access is enforced before blob reads.
For large binary reads use the authenticated `/documents/raw` endpoint; MCP base64
responses are capped at 1 MB. Writes accept up to 64 MB, with host route limits
allowed to be lower. Text editing is limited to valid UTF-8 files up to 2 MB; other
files remain available as original bytes through the documents surface or on disk.

### Proposals and publications (ADR 0055)

Two more members' surfaces, both enforced by core and served by the plugin:

- **Propose a change** — `POST /projects/:id/proposals` `{ title, body?, changes: [{ path, content } | { path, delete: true }] }` (also the MCP tool `propose_change`). Program paths only (store paths ship directly). Core commits the files on a fresh `work/proposals/<member>/<title>-<stamp>` branch from the shared `main`, authored as the member, and — when the project is linked to a code host with a ready service connection named like its provider (the organization's GitHub App as `github`, ADR 0177) — pushes it and opens a pull request "Proposed by <member> via Work". Without one the branch lands on the project origin, where holders of `program:read` see it. Approving and applying a proposal needs `program:publish`. Anyone who may use the project may propose.
- **Publications** — `POST /projects/:id/publications` `{ path, audience: "public" | "members", slug? }` → `{ slug, url, … }`; `GET` lists your own, or everyone's with `publications:read`; `DELETE …/:slug` revokes your own, or anyone's with `publications:write`. Publishing a program path needs `program:publish`; members publish what they may write (their own store documents). Serving: `GET /projects/:id/publications/:slug` for members (host auth) and `GET /public/:id/:slug` for `public` — the one route the identity hook lets through unauthenticated (route config `public: true`); it reads the document as an anonymous identity scoped to exactly that document, so nothing else is reachable. Unknown, revoked and not-for-you are one uniform 404.

### Reference architecture: a database per project

The capability seam is how embedders give every project real database
storage without Catamorphic knowing any vendor:

- **Internal tools / single server**: run a fleet of server-side PGlite
  instances (one datadir per project, hibernated when idle) behind a
  Postgres wire-protocol gateway such as `pg-gateway` on loopback. The
  provider resolves to `postgres://…@127.0.0.1` with per-project
  credentials; with `@catamorphic/local-process` execution, workflows reach
  it with no ingress or tunnels. Snapshot datadirs to S3 for backup.
- **Embedded SaaS at scale**: provision a managed Postgres per project
  (Neon-style database-per-tenant with scale-to-zero, or an equivalent
  service) from `onProjectCreated`, deprovision in `onProjectDeleted`, and
  mint short-lived pooled connection URLs in the provider. No long-lived
  credential is ever at rest in Catamorphic.

Both tiers are Postgres and both arrive as "a URL in env," so promoting a
project from the PGlite fleet to a managed database is a data migration,
not an app change.

## Bring your own doctrine (ADR 0049)

The framework ships mechanism plus good defaults; what work should *look
like* in your product is yours. Two `createCatamorphic` hooks receive the
framework defaults and return the host-final set — replacing or removing
entries is legitimate:

- `projectSeeds` — the per-project seed files (`.work/skills/…`). The
  seeded `building-apps` skill is mechanics (framework contracts — keep it);
  `designing-apps` is design doctrine, the seed you most likely swap for
  your own. These defaults also supply the host skill tier; agent turns never
  restore missing or deliberately deleted project skill files.
- `standingAgentPrompt` — the standing system prompt for agent sessions:
  omit for the default (`STANDING_AGENT_PROMPT`: general work, audience
  calibration, skills on demand), a string to replace, `false` for none.
  Keep it stable; per-turn facts belong in `harness.context(context)` fragments
  (ADR 0152), not the system prompt.

```ts
export const catamorphic = createCatamorphic({
  database: { pool: hostPgPool },
  storage: { projectsPath, remotesPath },
  environmentProvider,
  projectSeeds: (defaults) => {
    const seeds = { ...defaults };
    delete seeds[".work/skills/designing-apps/SKILL.md"];
    seeds[".work/skills/acme-design/SKILL.md"] = ACME_DESIGN_SKILL;
    return seeds;
  },
});
```

Everything resolves once at boot; the desktop app passes none of these and
runs on the defaults.

## Validating projects in CI or a local editor

Capability scaffolding includes `.work/scripts/check.ts` (project-owned;
the logic lives in the `@catamorphic/parser` devDependency).
`bun run --cwd .work check` parses the workspace,
validates trigger bindings (add `--host <url>` to check against a live
host's kind catalog), and fails on stale generated types; `--write`
regenerates the app-api types. Sandbox installs strip the tooling
dependency automatically, so it never reaches execution or app builds.

## Workflow authoring model

All exports are Workflows and every invocation is a Run. Every workflow is an
exported `defineWorkflow(({ defineBoundary, defineBatch }) => ({ steps: [...] }))`
value from `@catamorphic/workflow` (or a host wrapper):

- `defineBoundary` is an atomic retry scope whose callback operations retry together.
- `defineBatch` is a finite paged per-item processing scope with an optional sink.
- `defineBatchStep` physically coalesces compatible calls made inside `defineBatch.process`.
- `"use step"` functions hold IO and business operations, called from boundary
  run bodies and batch process callbacks.

These capabilities share workflow discovery, graph APIs, Runs routes, SDK
resources, React hooks, and UI. Do not introduce a public stage, category
selector, or capability-specific Run family. Apps consume workflows through a
single `Workflow<T>` contract from `@catamorphic/app`: the client exposes
`.call(input)` (waits for the terminal output; a workflow with no pause,
retry, rate limit, batch, or child call settles inline) and `.start(input)`
(returns a pollable run handle).

## Operational Notes

- `catamorphic.migrate()` / `catamorphic-db migrate` are idempotent and schema-scoped; run them in CI/deploy (preferred) or at boot.
- Catamorphic uses strict schema scoping on its own DB access: connection strings get `search_path = "catamorphic"`, host-provided pools get Kysely's `WithSchemaPlugin`. Unqualified names cannot fall through to `public`.
- Host-owned pools and Kysely instances are never destroyed by catamorphic; `catamorphic.close()` only closes what catamorphic created.
- Stop handles returned by `catamorphic.startExecutionWorker(...)` during host shutdown. Constructing the SDK or Fastify plugin never starts workers implicitly.
- Start `catamorphic.startAgentWorker({ resolveIdentity? })` after migrations when using coding agents. It restores due queue entries and persisted retries only for this host. Resolve current user authority through your auth model; the default uses Catamorphic memberships. `catamorphic.close()` stops both kinds of worker. Expired agent executions with uncertain outcomes require an explicit retry, not automatic side-effect replay (ADR 0094).
- Client reconnection does not restart execution. Automatic turn retries require a provider-confirmed rejection before execution began. Reconnecting to the same native provider attempt after an ambiguous disconnect is not yet implemented; the long-lived runtime cutover in ADR 0067 remains separate from this durable queue and progress model.

## Execution Environments and credential connections

Hosts own physical execution and provider credentials. Projects name logical
Environments in `.work/project.json` by what the work needs: workloads,
requirements, and an optional `pool` of machine labels (ADR 0167). The host's
`EnvironmentProvider` places work: `defineStaticEnvironments` picks the first
binding whose `labels` match the pool, and a scheduler receives the work's
owner (`ownerUserId`, absent for project work) to prefer machines reserved for
that person or their groups, using `accessTier` and `placementOrder` from
`@catamorphic/sandbox`. An Environment is project-visible policy, a binding is
its host-owned realization, and an Allocation is the immutable decision for
one root session or workflow run. Machine selection is never a project choice.

The managed multi-machine target is multiple Catamorphic server instances of
one logical authority, sharing network Postgres and accessible authoritative
storage ([ADR 0099](docs/decisions/0099-shared-postgres-server-environments.md)).
Project-facing Environments can bind to a named machine or a compatible pool;
hosts own the physical registration. Instance identity and execution ownership
must remain distinct from authority identity. Member-device execution appears
as **This machine** and does not require database credentials (ADR 0098).
The stock Postgres host implements shared objects, machine leases, auth, and
durable approvals. Custom hosts register `WorkerNodesService` leases, inject
`workerNode: { id, token }`, and renew/release them with their host lifecycle.
A host whose instances keep nothing durable on disk registers each process as
a new `disposable: true` node and calls `core.nodeRecovery.recoverLostNodes({
authorityId })` periodically: a disposable node that released its lease, or
whose lease lapsed past `LOST_NODE_GRACE_MS`, has its workflow runs moved to a
live node and its chats released for readmission
([ADR 0190](docs/decisions/0190-disposable-control-plane-replicas.md)).
A remote executor owns its node lease (ADR 0192): the host connects it with
`WorkerNodesService.connectRemote({ epoch, offer, ... })`, renews it from the
executor's own calls with `renewRemote`, and builds its sandbox provider from
the row with `remoteProvider`; any host of the authority then claims its
turns. `workerNode` names only the process's own local node.
Every operation is sealed to its executor's X25519 public key (ADR 0206):
register it with `registerExecutorKey({ db, executor: nodeExecutor(id),
publicKey })` before `connectRemote`, which refuses an executor without one.
Enable `clientExecution: true` to accept authenticated member sandbox runners,
which register their public key when they connect; `startClientRunner`
supplies the transport-independent client loop and opens what it receives
with `keys: { executor, privateKeys }` (`generateExecutorKeyPair` makes a
pair; the private key stays on the executor). See the
[cluster setup reference](skills/setup-work-server/references/cluster-deployment.md)
for the current limitations and required evidence. Custom hosts continue to
inject their own infrastructure and auth.

Pass `credentialVault` and `connectionProviders` to `createCatamorphic` when
external systems are enabled. The host vault stores opaque encrypted material using an injected store and key.
`EncryptedCredentialVault` can use `PostgresObjectStore` or a host store; the
wrapping key remains outside the database. Provider code runs in the control plane. Workflows call
`context.connections.<alias>.<action>(args)` and agents use allocation-bound
Catamorphic MCP grants. Neither receives upstream credentials.

Review policy is host code (ADRs 0162, 0183): pass `connectionGuards`, each a
`ConnectionActionGuard` (`name`, optional provider `kinds`, and
`review(context)` answering `allow`, `deny`, or `escalate`). The framework and
the Work server ship none. Core runs them in order on every brokered action
(connections, Git, models) and keeps the mechanics: any deny wins, a guard
that throws denies, one slower than `connectionGuardTimeoutMs` (default 30
seconds) escalates, an escalation asks the agent session's person or a project
chat's approvers with a request on the working turn (a workflow's is refused), and each
verdict lands in the connection audit. Guards skip connections outside their
`kinds`, so the audit holds only verdicts that were judged. Provider limits,
Git push rules, and model allowlists and budgets are mechanics and stay in
providers and bindings.
Connection aliases use letters, numbers, underscores, and hyphens only. Core
does not perform lossy alias normalization, so one alias always maps to one MCP
server and policy key.

Roles grant Environments and logical connection aliases separately. Project
permissions such as `program:write` do not imply managed-compute or
connection access. Projects cannot declare physical endpoints, OAuth clients,
credential values, or service identities.

Member connections use the authorization flow supported by the provider.
Project and tenant service connections are named (ADR 0172) and created only
by an identity with `connections:write` (`connections:read` reads them and
their audit): `POST /service-connections` creates one pending, and
`POST /service-connections/:id/authorize` runs the provider's own challenge
(form, URL returning to this API's `/connection-authorizations/callback`, or
device), which also rotates a ready one. These permissions are host-issued
(`Identity.controlPlanePermissions`, reported by `/me`); project roles cannot
grant `connections:*`. The Work server gives them to organization
administrators.

Environment bindings are committed in `.work/project.json`:
`environments.<name>.connections.<alias>` is
`{ provider, principal: "member" | "service" | "either", service?, capabilities? }`,
where `service` names a service connection (the project's own name first,
then the tenant's) and `capabilities` narrows the alias. Core reads them with
the Environment on demand; there is no binding table or API. A host may offer
extra aliases beside the committed ones with the `connectionBindings` option
of `createCatamorphic` (the desktop offers its profile MCP servers this way);
a committed alias of the same name wins. A trigger scan is the unattended
enablement boundary: it must resolve every required alias to a service
connection, then freezes those ids for dispatch; a later dispatch fails
closed if the name resolves elsewhere. Member connections are never eligible
for project automations (schedules, webhooks and events that run while nobody
is present). A project chat (owned by the project, not a member) uses the
service bindings of the Environment it runs in, whichever automation delivered
to it, and never a member's connection (ADR 0181). To keep a privileged
service action out of a local Environment, bind that alias only in the managed
Environment.

Git through the gateway (ADR 0175): a provider that serves Git sets
`git: { remoteBaseUrls, credentials({ material, remoteUrl, access }) }`
(`defineGitConnectionProvider` from `@catamorphic/server-sdk` covers any host
with a stored username and password or token; the GitHub provider mints
repository tokens). Such a connection carries `git:read` and `git:write`, and a
binding may add `git: { repositories?, push? }`. Pass `gatewayUrl` to
`createCatamorphic` (the plugin's `<api>/gateway` as sandboxes reach it; the
Work server uses its public URL, the desktop its loopback URL). At each sandbox
turn core writes the session's grant for every Git-capable alias into the
sandbox, configures `url.<gateway>/git/<alias>/.insteadOf <remote base>` and a
credential helper that reads the grant, and renews it while the turn runs.
The plugin serves Git smart HTTP at `/gateway/git/:alias/*` (public route;
the grant is the Basic password or a bearer), streams both directions, and
enforces the binding's repositories and push rules (never a default branch,
no deletes) before forwarding with the upstream credential; guards see kind
= the provider, action `fetch` or `push`, and the refs. Hosts with their own
401 challenge must leave `/gateway/` answering `WWW-Authenticate: Basic` so
Git's credential helpers run.

Models through the gateway (ADR 0180): a provider whose connection is a model
key sets `model: { api, baseUrl, headers({ material }) }`
(`defineModelConnectionProvider` from `@catamorphic/server-sdk`, `api`
`anthropic` or `openai`; `builtinModelConnectionProviders()` returns the
`anthropic` and `openai` kinds). Its connections carry the `model`
capability, and a binding may add `model: { allow? }`. The plugin serves
`/gateway/model/:alias/*` (public route; the grant is `x-api-key` or a
bearer), a thin pass-through: any method and path below the base URL, the
body byte for byte, headers but a small denylist (the caller's key, host,
cookies, hop-by-hop, proxy and forwarding headers), and the answer streamed
back unchanged. Guards see kind `model` with action = method and path
(`POST v1/messages`) and input = provider, model, stream; endpoint and
spending rules belong in guards. Usage lands in `model_usage` per session and
turn, read passively from Anthropic and OpenAI answers (zero when a format is
not recognized, such as a Chat Completions stream without
`stream_options.include_usage`). At each sandbox attempt core writes the grant of every model alias into
the sandbox (the same `sandbox`-channel grants as Git), and an agent
registered with `harness: { placement: "sandbox", id }` and `modelConnection:
<alias>` gets `AttemptStart.modelAccess = { kind: "gateway", ... }`. Core
starts the runner bundle (`@catamorphic/runner-bundle`) inside the sandbox
as a process with standard input (providers implement
`processes.writeProcessInput` for a process started with `stdin: true`); the
runner runs the harness's CLI beside the workspace, with the gateway as its
only model endpoint, and any replica can read it or reattach to it (ADR
0198). Harness binaries come from the Environment image.

HTTP APIs through the gateway (ADR 0211): a provider whose connection is an
HTTP API code in sandboxes may call sets `http: { baseUrl, paths?,
headers({ material }) }` (`defineHttpApiConnectionProvider` offers it for
connections without named `actions`; `auth: { basic: true }` sends a
`user:password` key as HTTP Basic). Its capabilities are the lowercase
methods. The plugin serves `/gateway/http/:alias` and everything below it
(public route; the grant is a bearer, the Basic password, or `x-work-grant`):
GET, HEAD, POST, PUT, PATCH and DELETE below the base URL and inside
`paths`, the method allowed by the binding (`get` covers HEAD), reads only
for a contained agent, bodies up to 32 MiB byte for byte, answers streamed,
the caller's authorization replaced by the stored key. Guards see kind = the
provider, action = the lowercase method, input = `{ path, query }`; each
request is audited as `connection.http`. At each sandbox turn core issues a
`sandbox` grant per HTTP alias and writes `.work-session/env/gateway.sh`
exporting `WORK_HTTP_<ALIAS>` (`<gatewayUrl>/http/<alias>`) and
`WORK_HTTP_<ALIAS>_GRANT_FILE`; the runner (`AttemptStart.envFiles`),
host harnesses' commands, setup and terminals load it beside `secrets.sh`.
Grants rotate on renewal, so code reads the file per request.

Personal credentials (ADRs 0184, 0199): a member's listed files may reach
sandboxes that run only that member's work. The member's client calls
`PUT /projects/:id/personal-environment` with `{ files: [{ path, content
/* base64 */ }] }` (at most 50 files of 256 KiB, repository-relative paths);
a body naming `logins` is refused with 400, since sign-ins stay on the
machine they were made on. `GET` answers `{ allowed, files: [{ path,
fingerprint, bytes, updatedAt }] }` and `DELETE` forgets them.
Values are sealed in `credentialVault` (required) as
`core.personalEnvironments`. An Environment opts in with
`personalCredentials: true`; admission then requires the chat's owner to be a
member (not the project principal) and the placement to isolate them:
binding isolation `sandbox`, a `device: "member"` Environment, an
`EnvironmentRuntimeBinding.servesOnlyOwner` from the host's provider, or the
machine capability `credentials.personal` (`MACHINE_CAPABILITIES` in
`@catamorphic/sandbox`). Register an agent with `signIn:
"claude-code" | "codex"` to run on the owner's own subscription (ADR 0199):
the sign-in is made on the machine that runs the chat (`work worker sign-in
<harness>` on a worker) and never leaves it. Work copies no sign-in.
Placement takes only machines that report `sign-in:<harness>:<member>`
(`signInCapability`), turns must be authored by the owner, and the sandbox
mounts that member's harness home (`CreateSandboxOpts.signIns`) so the
harness runs with `CLAUDE_CONFIG_DIR` or `CODEX_HOME` instead of the
gateway. Listed files are delivered to any of the
owner's chats in such an Environment, excluded from Git through
`.git/info/exclude`, and removed on close and idle release. Discovery items
carry `personalCredentials` when an Environment allows them.

Workspaces at a ref (ADR 0178): `create` and `deliver` accept
`workspace: { ref, update? }`. The control plane fetches the ref from the
project's linked remote (`projects.remote_url`) into a per-project bare mirror
(`StorageBackend.mirrorPath`, `FsBackend` keeps it under `.mirrors/`) with the
session's Git binding or, failing that, the code host's credentials
(`RemoteSyncService.origin`), publishes it as the session's `sessions/<id>`
branch, and seeds the sandbox from a shallow pack. Native checkouts receive
`workspace: { ref, commit, repository, pin }` in
`NativeAgentCheckout.resolve` (the base, or the one a pending move asks
for) and start a new worktree at that commit when the session has none of
its own. `resolve` returns `{ path, owned }`: `owned` is true only for a
checkout the host made for that session, and core moves a base only in an
owned checkout, never in a person's own folder. A session at a ref always
works in its own session copy, and its DTO reports `workspace: { ref, commit }`.

Long-lived API keys and service-account material use service connections, not
project secrets. A provider's `completeAuthorization` turns the challenge's
answer into vault material, so its checks (the Postgres provider's read-only
role check, an MCP OAuth exchange) always run. The broker opens the material
only for the provider call and passes `connection: { id, revision }` so a
provider can reuse upstream sessions per credential; a provider that does
implements `release({ connectionId })`, which core calls after rotation,
refresh, and revocation. A workflow step that will later invoke an agent
inherits the workflow's Environment, Allocation, and narrowed grants; it must
not create a second credential selection path.

Vault backup and rotation are host responsibilities. Back up encrypted records
and their wrapping key together, restrict both to the server account, rotate
service material through the connection API, and retain the old wrapping key
until every record has been re-encrypted. Public OAuth redirects require TLS, a
stable callback URL, and trusted proxy headers. MCP servers may support dynamic
client registration; Slack, Google, and providers that require pre-registration
still need deployment-owned client ids and secrets configured in the provider.

OAuth registries and MCP discovery do not remove deployment setup. Slack still
requires a Slack app with approved scopes. Google Workspace still requires a
Google Cloud OAuth client or a service account with administrator-approved
domain-wide delegation. Remote deployments need stable HTTPS callback URLs,
correct proxy headers, a backed-up vault key, and a documented rotation plan.


### Images, containers, and egress (ADR 0176)

An Environment may declare `image` (OCI reference or project Dockerfile),
`requirements.containers`, `network` (`open`, `gateway`, `allowlist`), and
`approvals.waitMinutes`. Admission turns them into capability requirements
(`images`, `images.build`, `containers`, `network.policy`) and fixes the
resolved image (Dockerfile content and digest), containers flag, and egress
allowlist in the Allocation; `allocationSandboxProvider` passes them to
`CreateSandboxOpts` (`image`, `containers`, `egress`). A provider lists what
it enforces in `SandboxProvider.capabilities` and must refuse create options
it cannot honor; include them in the binding descriptor's `capabilities` so
placement matches. Pass `gatewayHosts` (the control plane's public host) to
`createCatamorphic`: restricted egress always reaches it.

`MicrosandboxSandboxProvider` boots the image, runs Docker inside the VM on a
sandbox-owned disk (`containers`, `containerDiskMib`), builds Dockerfiles
with an injected `imageBuilder` (`dockerImageBuilder({ command })`), and
enforces egress with a deny-by-default network policy.
`LocalProcessSandboxProvider` offers containers on trusted machines through
`docker: { socketPath }`: a per-sandbox filtering endpoint that labels,
confines, and removes what the sandbox starts. It cannot enforce egress
unless the host sets `acceptUnenforcedEgress` knowingly.

### Managed workspace resources

Hosts that enroll multiple workers can import `WorkerNodesService`,
`WorkerCapacity`, and `cleanupWorkerAllocations` from `@catamorphic/server-sdk`.
Supply a workspace budget and CPU/memory defaults when registering a node, and
pass its lease to `createCatamorphic({ workerNode, ... })`. Return its physical
id and local lease token with the injected Environment runtime binding. Keep
heartbeats and cleanup independent; call cleanup only on the sandbox's physical
owner. Stock provisioning is an example, not a library dependency.

Managed Allocations reserve resources atomically in the host's schema-scoped
Postgres. A session holds its workspace between turns. Retiring it does not free
capacity until sandbox destruction succeeds. Every Allocation owns at most one
sandbox, keeping workflow runtime reuse within that workspace and resource limit.
Providers advertise `resourceLimits` and enforce `CreateSandboxOpts.resources`;
unsupported limits fail rather than falling back to unbounded execution. Native
host CLI execution does not inherit controller-sandbox resource guarantees.
See [ADR 0100](docs/decisions/0100-workspace-resource-admission.md) and the
[stock setup example](skills/setup-work-server/references/cluster-deployment.md#capacity-and-isolated-development).

### Agent context and deferred host capabilities

[AGENT-CAPABILITIES.md](AGENT-CAPABILITIES.md) describes compact per-turn user and
execution context, the typed capability registry, permission-filtered discovery,
MCP/HTTP transports, and host directory/approval integration. Use these existing
seams when agents need environment or assignment awareness.

## Maintained host examples

The [React host examples](packages/registry/src/examples/embedding.tsx) compile with
the registry on every check. They demonstrate controlled chat selection and a
host-owned workflow inspector. [Chat delivery responsibilities](apps/desktop/docs/chat-state.md)
separate reusable mechanics from the desktop reference presentation.

### Contained project workspace and local data

Project capabilities live in an independent `.work/` Bun workspace; code
builds its paths and Git names from `@catamorphic/workflow/project-layout`.
Hosts check it the way publishing does (the project MCP `program_check`
tool). `bun install --cwd .work` and `bun run --cwd .work check` do the same
locally, but the `@catamorphic/*` packages are not yet on a public registry,
so the install needs a registry that serves them (the repository's dev-only
`infra/local-registry`).
Imports and ordinary agent work leave existing repository files untouched.
The workspace is created when workflows, apps, or other capabilities need it.

Local-process and microsandbox hosts can inject `projectDataDirectory` into
their provider, an async callback receiving `{ projectId }` and returning
an absolute persistent directory or `undefined`. For a project attached to a
local folder, core's `projectDataDirectory({ root })` prepares
`.work/app-data/` and creates `.work/.gitignore` only if absent.
Deployment runtimes expose this storage as `WORK_APP_DATA_DIR`;
workflow code should create its own named subdirectory there. Microsandbox
bind-mounts the folder; local-process uses its absolute host path. The data
outlives a runtime or deployment. Build and agent sandboxes do not receive it.
Cloud providers retain their existing storage contracts.

The scoped ignore file excludes app data by default. Owners can edit it to
track ordinary data deliberately. Mutable data is excluded from immutable
execution snapshots and the shared program/document surface. Documents retain
logical `store/...` API addresses, backed locally by
`.work/app-data/store/...`. Personal artifact privacy remains separately
enforced. Per-user app view preferences, credentials, and conversation state
remain in the host's database or private data directory. Database export and
restore are not provided.
