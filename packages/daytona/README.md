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
import { createCatamorphic } from "@catamorphic/server-sdk";

const catamorphic = createCatamorphic({
  database: { connectionString: process.env.DATABASE_URL! },
  storage: { projectsPath: "...", remotesPath: "..." },
  sandboxProvider: new DaytonaSandboxProvider({
    apiKey: process.env.DAYTONA_API_KEY!,
  }),
});
```

## Testing

Integration tests hit the real Daytona API and run automatically whenever
`DAYTONA_API_KEY` is present in the repo root `.env`:

```sh
bun run test
```
