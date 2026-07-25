# Catamorphic Playground

Reference **host application** demonstrating a full catamorphic embed on the
Cloudflare stack:

- **Workflow execution + dev sandboxes**: Cloudflare Sandbox via the
  [Bridge Worker](../../packages/cloudflare-sandbox-bridge/README.md)
  (`CloudflareSandboxProvider` from `@catamorphic/cloudflare`).
- **Code storage**: S3-compatible storage (`S3RemoteBackend`) when `S3_*` is
  configured, including Cloudflare R2, AWS S3, or MinIO. Cloudflare Artifacts
  (`ArtifactsRemoteBackend`) is next when configured and available; filesystem
  remotes are the local fallback.
- **Coding agent**: Vercel AI SDK (`AiSdkCodingAgent` from
  `@catamorphic/ai-sdk`). The tool loop runs in the playground server process and
  edits the project inside the Cloudflare dev sandbox; changes come back as an
  uncommitted draft. Model: `CODING_AGENT_MODEL`, defaulting to `openai/gpt-5.2-codex`
  when `OPENAI_API_KEY` is set.
- **State**: Postgres, schema-scoped to `catamorphic`.
- **API**: Fastify with `@catamorphic/fastify-plugin` mounted at `/api`.
- **Run worker**: explicitly started by the host after the API is listening;
  Postgres owns queued execution, retries, pauses, and continuation state.
- **UI**: Vite + React using `@catamorphic/react` hooks and the
  `@catamorphic/ui` `<WorkflowEditor>`, plus an AI chat panel wired to the
  agent-session routes. One Runs surface handles every Workflow and reveals
  controls from Run capabilities. The host always supplies test execution;
  the editor derives Test visibility and availability from the current parsed
  graph so unsaved capability changes take effect immediately.

The playground stands in for the host's auth: it injects a fixed demo
tenant/user server-side (`src/server/index.ts`) the way a real host would
inject identity from its verified session.

## Running

One-time setup (from the repo root):

1. `cp apps/playground/.env.example apps/playground/.env` and point
   `DATABASE_URL` at your Postgres — the docker-compose one is
   `postgresql://catamorphic:catamorphic@localhost:5432/catamorphic`.
2. Repo root `.env` with `CLOUDFLARE_SANDBOX_API_URL`. For durable git origins,
   configure S3-compatible storage (`S3_BUCKET`, `S3_ACCESS_KEY_ID`,
   `S3_SECRET_ACCESS_KEY`, plus endpoint/region as needed), or optionally the
   Artifacts vars (`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`,
   `CLOUDFLARE_ARTIFACTS_NAMESPACE`).
3. Docker running (the sandbox bridge builds/runs containers locally).

Then, from the repo root:

```sh
bun run dev
```

This starts everything: docker-compose infra (Postgres, OTel collector,
ClickHouse), a one-off build of the workspace packages the playground
consumes, the Cloudflare sandbox bridge (`:8787`), and the playground
itself — API server (`:8500`) + Vite (`:5173`).

To run just the playground against already-running infra:

```sh
cd apps/playground
bun run dev            # starts the API server (:8500) + Vite (:5173)
```

Open http://localhost:5173 — create a project from a template, open a
workflow, edit the code, hit **Run** (executes in a real Cloudflare sandbox)
and **Deploy** (commits + pushes to the project's origin — Artifacts when
enabled). The **AI assistant** panel on the right chats with the AI SDK agent;
its edits appear as draft changes you can review and deploy.

Migrations are applied automatically at server boot (`catamorphic.migrate()`).

Templates demonstrate both authoring shapes without introducing Workflow
kinds: exact `"use workflow"` functions have no persisted continuation, while
`defineWorkflow(({ defineBoundary, defineBatch }) => ({ steps: [...] }))`
composes atomic retry boundaries and paged per-item batch scopes. The Runs UI,
API, and history remain the same for both.

## Verification

From the repository root:

```sh
bun run lint
bun run typecheck
bun run build
bun run test
```

## Observability

The playground exports OpenTelemetry traces over OTLP/HTTP. The dev
docker-compose (repo root) ships a collector + ClickHouse pair for storing
them:

```sh
docker compose up -d clickhouse otel-collector   # from the repo root
```

- Collector listens on `localhost:4317` (gRPC) / `localhost:4318` (HTTP) and
  writes to ClickHouse database `otel` (table `otel_traces`).
- ClickHouse host ports are shifted to avoid clashing with other local
  stacks: HTTP on `localhost:8124`, native TCP on `localhost:19001`
  (credentials `catamorphic`/`catamorphic`).
- The server defaults to `http://localhost:4318`; override with
  `OTEL_EXPORTER_OTLP_ENDPOINT` or disable with `OTEL_SDK_DISABLED=true`.
  Running without the collector is harmless — export failures are silent.

Query spans, e.g.:

```sh
echo "select Timestamp, SpanName, Duration/1e6 as ms from otel.otel_traces order by Timestamp desc limit 20" \
  | curl -s "http://localhost:8124/" -u catamorphic:catamorphic --data-binary @-
```
