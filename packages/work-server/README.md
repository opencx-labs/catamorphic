# @catamorphic/work-server

The Work server as a library (ADR 0160). Deploy it from your own TypeScript
entry point and image, pinned to the release you run (ADR 0287). Work
publishes libraries; your server supplies its hooks.

```ts
import {
  createWorkServer,
  workServerConfigFromEnv,
} from "@catamorphic/work-server";

const server = await createWorkServer({
  config: workServerConfigFromEnv(process.env),
  hooks: {
    connectionProviders: [myInternalToolsProvider],
    routes: ({ app }) => {
      app.get("/internal/ping", async () => ({ ok: true }));
    },
  },
});
await server.operatorApp.listen({ port: 4701, host: "127.0.0.1" });
await server.app.listen({ port: 4700, host: "0.0.0.0" });
```

## Config is data, hooks are code

`config` is a typed, serializable `WorkServerConfig`, validated at boot by the
same schemas as the environment parser. `hooks` are code. Only
`workServerConfigFromEnv` knows the `WORK_*` variables and file paths
documented in [`apps/server`](../../apps/server/README.md): it reads
`WORK_AUTH_CONFIG` (default `<WORK_DATA_DIR>/auth-config.json`) into
`config.auth` and `WORK_GATEWAY_CONFIG` into `config.gateway`, resolving each
secret a file names by variable into its value (ADR 0183). `createWorkServer`
reads no configuration file.

A server can build the config in code instead, for example from a secret
manager:

```ts
const base = workServerConfigFromEnv(process.env);
const server = await createWorkServer({
  config: {
    ...base,
    auth: {
      providers: [
        {
          kind: "google-workspace",
          clientId: secrets.googleClientId,
          clientSecret: secrets.googleClientSecret,
          domains: ["example.com"],
          // The service account key itself; no file on disk.
          directory: { credentials: { key: secrets.directoryKey } },
        },
      ],
    },
    gateway: {
      connections: [
        {
          kind: "slack-mcp",
          displayName: "Slack",
          url: "https://mcp.slack.com/mcp",
          oauth: { client: { id: "1234.5678", secret: secrets.slackSecret } },
        },
      ],
    },
  },
});
```

`WorkAuthConfigSchema` and `GatewayConfigSchema` are exported for hosts that
validate earlier. Generated state stays in files under `dataDir` (the vault
key, the generated secrets, the host id, worker credentials); the matching
config fields and hooks (`secret`, `vaultKeys`, `operatorSecret`) supply them
instead. With `databaseUrl` the server is a disposable replica (ADR 0190):
`secret`, vault keys, and `operatorSecret` are required, it writes no identity
to `dataDir`, and it registers a new machine at every start. `server.lost`
resolves when that machine's lease is lost (`/healthz` then answers 503;
`/readyz` answers 503 whenever renewals fail); the host should then shut down so
its supervisor starts a fresh process.

## Hooks

| Hook | Adds |
| --- | --- |
| `agentCapabilities` | Host capabilities, profiles, and approvals for agents |
| `capabilityProviders` | Existing SDK capability providers and `context.host` workflow calls; authorize each call using its host-stamped caller |
| `connectionProviders` | Connection providers beside the configured MCP endpoints |
| `github` | Options of the built-in `github` connection provider: Enterprise Server URLs, the App's OAuth client for members' own connections (ADR 0177) |
| `connectionGuards` | Guards that review each gateway action (ADR 0162). Work ships none; a guard is host code (ADR 0183) |
| `vaultKeys` | Credential vault keys from a key service instead of `WORK_VAULT_KEY` |
| `directories` | Upstream directories (beyond Google Workspace) that keep accounts active or disable them (ADR 0161) |
| `machineProvisioner` | Creates and destroys worker machines on a platform Work does not ship, for `custom` machine classes, so machine rules give people and teams their own machines, or machines on demand for waiting work. `create` gets the class's `options`, the rule, and what the waiting work needs, and is idempotent per enrollment code (`enrollment.idempotencyKey`); `destroy` removes every machine with the name and answers `{ done }` (ADRs 0167, 0205, 0258) |
| `hetzner` | Hetzner Cloud API options for `hetzner-cloud` machine classes: another endpoint, or a `fetch` for tests (the token is `WORK_HETZNER_TOKEN`) |
| `projectSeeds` | Changes to the files seeded into new projects |
| `routes` | Extra routes on the public application |

Hooks extend the server. They cannot remove sign-in, admission, membership
resolution, the loopback-only operator listener, or execution fencing.

## Guards

A guard is a `ConnectionActionGuard`: a `name`, optional connection `kinds`,
and `review(context)` answering `allow`, `deny`, or `escalate`. Guards are
company policy, so they live in the host's code, not in Work (ADR 0183). The
server keeps the mechanics: a guard that throws denies, one slower than
`config.connectionGuardTimeoutMs` (default 30 seconds) escalates, an
escalation asks the agent's person or the chat's approvers, and every verdict
is in the connection audit. Name `kinds` so a guard only sees the connections
it judges. Examples:
[secrets and the gateway](../../skills/setup-work-server/references/secrets-and-gateway.md#guards-are-host-code).

## Your own image

Install an exact `@catamorphic/work-server` release in your own Bun project.
Commit `package.json` and `bun.lock`, keep Catamorphic packages on that same
release, and add any SDKs your hooks use. Start from the boot/listen/shutdown
example in [`apps/server/src/index.ts`](../../apps/server/src/index.ts), or
compose `createWorkServer` directly. Keep the operator listener on loopback,
stop on `server.lost`, and handle SIGTERM with a bounded shutdown.

When copying the reference server or worker entry point, copy the complete
`dependencies` from that release's [`apps/server/package.json`](../../apps/server/package.json)
into your own manifest, replacing each `workspace:*` with that exact Work
version. This manifest includes the OpenTelemetry SDK, resources and exporters
required by the entry points' static `@catamorphic/otel/node` import. They are
needed even with telemetry disabled. Installing only `@catamorphic/work-server`
and `@catamorphic/otel` is insufficient for those copied entry points. A host
that supplies its own entry point without `@catamorphic/otel/node` can use a
smaller dependency set.

Create a `.dockerignore` before building:

```text
node_modules
**/node_modules
.git
.env
.env.*
.work/app-data
server-data
```

This keeps local dependencies from overwriting the image's Linux install and
keeps credentials and mutable state out of the build context.

A minimal company-owned image for a project with `server.ts`:

```dockerfile
FROM oven/bun:1.4.4
USER root
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY . .
RUN mkdir -p /data && chown bun:bun /data
USER bun
ENV WORK_DATA_DIR=/data
EXPOSE 4700
CMD ["bun", "server.ts"]
```

Exclude secrets and local state from the build context. Add the toolchain,
health check and assets your deployment uses; this minimal example does not
supply them. If serving the PWA, build that release's `apps/pwa` and supply
its output through `config.pwaDist` or `WORK_PWA_DIST`. Verify `/readyz`, OAuth,
SIGTERM, restart recovery, and your actual workloads in your own image.

For enrolled workers, build a worker image with the same pinned library.
The installer currently starts `bun apps/server/src/worker.ts`, so include
that release's `worker.ts`, `worker-cli.ts` and `work.ts` at those paths,
plus the complete reference manifest dependencies described above. Install a `work` command forwarding to `work.ts` for
machine-local sign-in commands. Set `config.workerImage` or
`WORK_WORKER_IMAGE` to that exact image. Control-plane hooks and credentials
stay off workers. A workflow launching its own external runner does not need
this enrollment or image contract.

## Compose the use case

A missing native service integration is ordinary application work when the
existing primitives suffice. Use project workflows for orchestration and
reconciliation, npm SDKs for IO, and an application-owned Postgres schema or
database for job state, receipts, inboxes and publication effects. Use
`hooks.connectionProviders` for brokered service actions,
`hooks.capabilityProviders` for workflow host calls, and `hooks.routes` for
authenticated callbacks. `agentCapabilities` serves agent tools and is a
different contract. Check caller identity and project authority inside each
host function; registering a function is not an authorization policy.

Do not expose allocator, database or GitHub write credentials to untrusted
review code. Launching an external runner through an AWS SDK does not
require a Work machine provisioner. Use `machineProvisioner` when Work's own
machine rules should provision enrolled execution capacity. See
[workflow composition](../../skills/setup-work-server/references/workflow-composition.md)
for the guarantees, recovery design and acceptance tests.
