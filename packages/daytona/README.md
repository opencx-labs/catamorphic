# @catamorphic/daytona

Daytona backend plugin for catamorphic. Install this package when your host
uses [Daytona](https://www.daytona.io/) instead of the default Cloudflare
stack (see `docs/decisions/0008` for the plugin-package layout):

- **`DaytonaSandboxProvider`** — implements `SandboxProvider` (from
  `@catamorphic/sandbox`) using the Daytona SDK.
- **`DaytonaBackend`** — experimental `StorageBackend` (from
  `@catamorphic/git`) that keeps project working trees inside Daytona
  sandboxes.
- **`DaytonaProjectRepo`** — `ProjectRepo` implementation that shells out to
  `git` inside a Daytona sandbox.

## Usage

```ts
import { DaytonaSandboxProvider } from "@catamorphic/daytona";
import {
  createCatamorphic,
  defineStaticEnvironments,
} from "@catamorphic/server-sdk";

const sandboxProvider = new DaytonaSandboxProvider({
  apiKey: process.env.DAYTONA_API_KEY!,
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

const catamorphic = createCatamorphic({
  database: { connectionString: process.env.DATABASE_URL! },
  storage: { projectsPath: "...", remotesPath: "..." },
  sandboxProvider,
  environmentProvider,
});
```

## Testing

The ordinary root `bun run test` stays deterministic and never treats ambient
credentials as authority. To run the real Daytona integration with
`DAYTONA_API_KEY` configured, opt in explicitly from the repo root:

```sh
bun run test:external
```
