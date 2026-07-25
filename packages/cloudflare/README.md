# @catamorphic/cloudflare

Cloudflare backend plugin for catamorphic. Install this package when your host
runs on the Cloudflare stack (the default recommendation — see
`docs/decisions/0004` and `docs/decisions/0008`):

- **`CloudflareSandboxProvider`** — implements `SandboxProvider` (from
  `@catamorphic/sandbox`) against the [Sandbox Bridge Worker](../cloudflare-sandbox-bridge/README.md).
  Used for both workflow-execution sandboxes and dev (coding agent) sandboxes.
- **`ArtifactsRemoteBackend`** — implements `RemoteBackend` (from
  `@catamorphic/git`) on top of [Cloudflare Artifacts](https://developers.cloudflare.com/artifacts/).
  Each project's canonical bare repo is an Artifacts repo, reachable over
  standard git smart-HTTP.
- **`ArtifactsClient`** — minimal REST client for the Artifacts control plane
  (create/delete repos, mint short-lived per-repo git tokens).

## Usage

```ts
import {
  ArtifactsClient,
  ArtifactsRemoteBackend,
  CloudflareSandboxProvider,
} from "@catamorphic/cloudflare";
import { FsBackend, ProjectManager } from "@catamorphic/git";
import { createCatamorphic } from "@catamorphic/server-sdk";

const artifacts = new ArtifactsClient({
  accountId: process.env.CLOUDFLARE_ACCOUNT_ID!,
  apiToken: process.env.CLOUDFLARE_API_TOKEN!,
  namespace: process.env.CLOUDFLARE_ARTIFACTS_NAMESPACE!,
});

const catamorphic = createCatamorphic({
  database: { connectionString: process.env.DATABASE_URL! },
  storage: {
    projectManager: new ProjectManager(
      new FsBackend("/var/catamorphic/projects"),
      new ArtifactsRemoteBackend({
        client: artifacts,
        cachePath: "/var/catamorphic/artifacts-cache",
      }),
    ),
  },
  sandboxProvider: new CloudflareSandboxProvider({
    apiUrl: process.env.CLOUDFLARE_SANDBOX_API_URL!,
    apiKey: process.env.CLOUDFLARE_SANDBOX_API_KEY,
  }),
});
```

## How `ArtifactsRemoteBackend` works

- `initRemote` creates one Artifacts repo per project
  (`<prefix>--<tenantId>--<projectId>`, default branch `main`).
- `withOrigin` syncs the Artifacts repo into a **local bare mirror** under
  `cachePath` (git fetch over HTTPS), runs the callback against the mirror via
  the same `OriginRepo` interface as `FsRemoteBackend`, then pushes any
  changed `refs/heads/*` back. The mirror is a disposable cache.
- `getCloneSource` mints a short-lived scoped repo token and returns
  `{ url, username, password }` so **sandboxes `git clone` the project
  directly from Artifacts** instead of receiving file uploads from the host.
  Production deployment runtimes and dev sandboxes use this path.

Artifacts is in closed beta. Accounts without access get REST error `10004`
("Access denied by feature gate") — `ArtifactsApiError.codes` exposes it so
hosts can fall back. The playground prefers `S3RemoteBackend` when configured,
then Artifacts, then `FsRemoteBackend`.

## Testing

- `bun run test` — unit tests (mocked fetch).
- Integration tests (real services, keys from repo root `.env`):
  - `src/__tests__/artifacts.integration.test.ts` — full Artifacts round-trip
    (create repo → initial push → seed second working copy → external git
    clone → delete). Auto-skips with a warning while the account is
    feature-gated.
  - `src/__tests__/sandbox-provider.integration.test.ts` — real sandbox exec
    via the bridge. Opt in with `CF_SANDBOX_INTEGRATION=1` and a running
    bridge (`bun run dev` in `packages/cloudflare-sandbox-bridge`).
