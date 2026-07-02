# Catamorphic Playground

Reference **host application** demonstrating a full catamorphic embed on the
Cloudflare stack:

- **Workflow execution + dev sandboxes**: Cloudflare Sandbox via the
  [Bridge Worker](../../packages/cloudflare-sandbox-bridge/README.md)
  (`CloudflareSandboxProvider` from `@catamorphic/cloudflare`).
- **Code storage**: Cloudflare Artifacts (`ArtifactsRemoteBackend`) — each
  project's canonical git repo lives in Artifacts, and sandboxes `git clone`
  it directly with short-lived tokens. Falls back to filesystem remotes (with
  a warning) while the Cloudflare account's Artifacts beta access is pending.
- **Coding agent**: [Flue](https://flueframework.com) (`FlueCodingAgent` from
  `@catamorphic/flue`). The harness runs in the playground server process and
  edits the project inside the Cloudflare dev sandbox; changes come back as an
  uncommitted draft. Model: `FLUE_MODEL`, defaulting to `openai/gpt-5.2-codex`
  when `OPENAI_API_KEY` is set.
- **State**: Postgres, schema-scoped to `catamorphic`.
- **API**: Fastify with `@catamorphic/fastify-plugin` mounted at `/api`.
- **UI**: Vite + React using `@catamorphic/react` hooks and the
  `@catamorphic/ui` `<WorkflowEditor>`, plus an AI chat panel wired to the
  agent-session routes.

The playground stands in for the host's auth: it injects a fixed demo
tenant/user server-side (`src/server/index.ts`) the way a real host would
inject identity from its verified session.

## Running

Prereqs (from the repo root):

1. Postgres — `docker run -d --name catamorphic-dev-pg -p 5433:5432 -e POSTGRES_USER=catamorphic -e POSTGRES_PASSWORD=catamorphic -e POSTGRES_DB=catamorphic postgres:17`
   (or point `DATABASE_URL` in `apps/playground/.env` at your own).
2. Sandbox bridge — `bun run dev` in `packages/cloudflare-sandbox-bridge`
   (requires Docker; serves `http://localhost:8787`).
3. Repo root `.env` with `CLOUDFLARE_SANDBOX_API_URL`, and optionally the
   Artifacts vars (`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`,
   `CLOUDFLARE_ARTIFACTS_NAMESPACE`).

Then:

```sh
cd apps/playground
cp .env.example .env   # adjust DATABASE_URL if needed
bun run dev            # starts the API server (:8500) + Vite (:5173)
```

Open http://localhost:5173 — create a project from a template, open a
workflow, edit the code, hit **Run** (executes in a real Cloudflare sandbox)
and **Deploy** (commits + pushes to the project's origin — Artifacts when
enabled). The **AI assistant** panel on the right chats with the Flue agent;
its edits appear as draft changes you can review and deploy.

Migrations are applied automatically at server boot (`catamorphic.migrate()`).
