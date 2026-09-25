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

`workServerConfigFromEnv` parses the `WORK_*` variables documented in
[`apps/server`](../../apps/server/README.md). A server can also build a
`WorkServerConfig` in code.

## Hooks

| Hook | Adds |
| --- | --- |
| `agentCapabilities` | Host capabilities, profiles, and approvals for agents |
| `connectionProviders` | Connection providers beside the configured MCP endpoints |
| `directories` | Upstream directories (beyond Google Workspace) that keep accounts active or disable them (ADR 0161) |
| `projectSeeds` | Changes to the files seeded into new projects |
| `routes` | Extra routes on the public application |

Hooks extend the server. They cannot remove sign-in, admission, membership
resolution, the loopback-only operator listener, or execution fencing.

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
