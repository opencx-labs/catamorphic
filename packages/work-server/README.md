# @catamorphic/work-server

The Work server as a library (ADR 0160). The published `work-server` image is
a thin process around this package; a company that needs custom code runs the
same server with its own hooks instead of forking it.

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
same schemas as the image's files. `hooks` are code. Only
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
| `connectionProviders` | Connection providers beside the configured MCP endpoints |
| `github` | Options of the built-in `github` connection provider: Enterprise Server URLs, the App's OAuth client for members' own connections (ADR 0177) |
| `connectionGuards` | Guards that review each gateway action (ADR 0162). Work ships none; a guard is host code (ADR 0183) |
| `vaultKeys` | Credential vault keys from a key service instead of `WORK_VAULT_KEY` |
| `directories` | Upstream directories (beyond Google Workspace) that keep accounts active or disable them (ADR 0161) |
| `machineProvisioner` | Creates and destroys worker machines on a platform, so machine rules give people and teams their own machines (ADR 0167) |
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

## Extending the image

Keep the published image as the base so security fixes arrive with each
release:

```dockerfile
FROM ghcr.io/<owner>/work-server:<version>
COPY server.ts /app/apps/server/custom/server.ts
CMD ["bun", "apps/server/custom/server.ts"]
```

The image's workspace uses isolated installs, so place the file under
`apps/server/`: from there it resolves `@catamorphic/work-server` and the
server's other dependencies. Pin an exact version and rebuild on every
release. Copy the process concerns you need (listening, signals) from
[`apps/server/src/index.ts`](../../apps/server/src/index.ts).
