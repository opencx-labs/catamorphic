# @catamorphic/cloudflare-sandbox-bridge

Cloudflare Worker exposing native container execution to a host outside Workers.
`CloudflareSandboxProvider` in `@catamorphic/cloudflare` calls its authenticated
HTTP API. Hosts still construct their provider explicitly.

The `NativeSandbox` Durable Object starts its container through `ctx.container`.
`@cloudflare/sandbox` 1.x supplies `Files`; the matching `sandbox-shim` runs in
our image. Routing, authentication and SSE framing live in this package.
See [CLOUDFLARE.md](../../CLOUDFLARE.md) and
[ADR 0310](../../docs/decisions/0310-cloudflare-sandboxes-use-native-containers.md).

## Local development

Use the task's dedicated worktree with dependencies installed and Docker
running:

```sh
cp packages/cloudflare-sandbox-bridge/.dev.vars.example packages/cloudflare-sandbox-bridge/.dev.vars
bun run --cwd packages/cloudflare-sandbox-bridge dev
```

The Worker listens at `http://localhost:8787` and builds its image locally.
`GET /health` is public and starts no container:

```sh
curl http://localhost:8787/health
```

Every other route checks `Authorization: Bearer <SANDBOX_API_KEY>`.
An unset key is accepted only when the request URL uses a loopback hostname;
a deployed Worker without a key returns 503.

Construct the provider in the host:

```ts
const sandboxProvider = new CloudflareSandboxProvider({
  apiUrl: "http://localhost:8787",
  apiKey: "local-dev",
});
```

The root `bun run dev:infra` also starts the optional bridge. The reference
hosts choose their own provider; running the bridge does not switch them.

## Deployment

Cloudflare's native Durable Object container scheduling policy is in public
beta. Deployment needs a Workers Paid account with Containers enabled and a
Docker installation to build the image. The default Wrangler configuration is
production (`catamorphic-sandbox-bridge-native`); `--env dev` uses the separate
`catamorphic-sandbox-bridge-dev-native` Worker. These replacement Workers own new
Durable Object namespaces and never reuse a legacy Sandbox namespace.

```sh
bunx wrangler secret put SANDBOX_API_KEY --env ""
bunx wrangler deploy --env ""
```

Pass the deployed URL and the same key to `CloudflareSandboxProvider` in the
host. Deployments are explicit operations, separate from installing packages or
running checks. Cloudflare cannot change an existing Container application's
scheduling policy or attach the replacement to its Durable Object namespace.
Keep the previous Worker available while draining its allocations. Preserve files
that cannot be rebuilt, release allocations through the old provider, then
restart the host against the new URL/key and admit fresh allocations. Container
files, snapshots and Durable Object storage do not transfer between namespaces.
Retire the old Worker only after verifying it has no work or unique data left.

## Container lifecycle

Allocating an id starts no container. The first command or file operation
starts the configured `sandbox` image as a `lite` instance with Internet access.
Native exec receives its own environment and working directory on each call.
Idle containers stop after ten minutes; the timeout is restored when the Durable
Object restarts. Destroy stops the container immediately. Warm pools and cron
priming are unnecessary with native scheduling.

The native scheduling configuration has no `max_instances` field. The host's
Environment and Allocation policies own work admission. Change instance sizing
in `SandboxBridge.start`, rather than adding framework-specific project settings.

## HTTP API

| Request | Behavior |
| --- | --- |
| `GET /health` | Return `{ "ok": true }` without starting a container |
| `POST /v1/sandbox` | Allocate an opaque sandbox id |
| `DELETE /v1/sandbox/:id` | Stop the container immediately |
| `GET /v1/sandbox/:id/running` | Return `{ "running": boolean }` without starting it |
| `POST /v1/sandbox/:id/exec` | Run native exec and stream SSE output |
| `PUT /v1/sandbox/:id/file/<absolute-path>` | Create parents and atomically replace a file with the raw request body |
| `GET /v1/sandbox/:id/file/<absolute-path>` | Stream raw file bytes |
| `POST /v1/sandbox/:id/hydrate` | Extract a streamed tar archive into `/workspace` |

Exec accepts `{ argv: string[], cwd?: string, env?: Record<string, string>,
timeout_ms?: number }`. Its default directory is `/workspace` and its default
deadline is five minutes. Commands do not inherit variables from a previous
command. `CloudflareSandboxProvider` passes shell commands as `sh -lc` arguments,
with environment values kept in native exec options.

SSE `stdout` events contain base64 bytes from the combined output stream.
An `exit` event contains `{ "exit_code": number }`; an `error` event reports
native execution failure or cancellation. A GNU timeout deadline returns a
nonzero exit code. Commands run under GNU `timeout`, which
owns their process group. Deadlines and response cancellation kill the group,
including ordinary shell descendants; a process that deliberately starts a new
session is outside that group. GNU timeout owns the deadline without a Worker
timer. Request listeners are removed when `exitCode` settles, before a finished
process can receive a late signal.
The `enable_request_signal` compatibility flag propagates disconnects through
the Worker's call to the Durable Object's `fetch()` method. The Worker passes
`signal: request.signal` explicitly; the compatibility flag does not imply
automatic signal passthrough.
File path segments are URL decoded, including scoped package names and spaces.

## Updating dependencies

Keep `@cloudflare/sandbox` and the `sandbox-shim` image tag in the Dockerfile at
the same exact version. Bun and Node in the image are pinned independently.
The image runs `sleep infinity`; native execution needs no in-container HTTP
control-plane server. Verify the provider and bridge together with the normal
repository checks. Credentialed Cloudflare integration tests remain explicitly
opt-in through `bun run test:external` and their documented environment flags.
