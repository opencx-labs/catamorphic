---
name: plugin-e2e-integration
description: Use when integrating, debugging, or documenting how an external workflow plugin package (a package.json with a `catamorphic` manifest) is resolved, attached to a project, given secrets, shipped into a deployment, executed, and described to coding agents.
---

# Plugin end-to-end integration

Applies to any plugin package that follows the manifest contract, whatever its
vendor or domain. Deep reference: `packages/plugins/README.md`. Host wiring:
`INTEGRATION.md` ("Plugin packages" and "Capabilities, lifecycle hooks, and
plugin host halves").

## The path a plugin takes

1. **Resolve.** The host passes `createCatamorphic({ pluginResolver })`, for
   example `new LocalPluginResolver({ rootDir })` (exported by
   `@catamorphic/server-sdk`). Each immediate subdirectory of `rootDir` is a
   built package whose `package.json` carries a `catamorphic` field. The
   resolver never builds packages. Neither in-repo host (desktop, stock
   server) configures a resolver, so plugins are an embedder feature.
2. **Attach.** `POST /api/projects/:projectId/plugins` and
   `DELETE .../plugins/:packageName` need `program:publish`.
   `GET /api/plugins/catalog` lists what the resolver found.
3. **Secrets.** Each declared manifest secret is set with
   `PUT /api/projects/:projectId/secrets/:name` (`secrets:write`), or supplied
   by a host capability provider for a manifest `requires` entry (ADR 0046).
   Resolution order per run: capability provider value, stored secret,
   manifest default. Runs use the `production` secret stage.
4. **Deploy and run.** Deploy the project commit
   (`POST /api/projects/:projectId/deploy`), then trigger through the host UI
   or `POST /api/projects/:projectId/workflows/:name/runs`. `RunPluginsLoader`
   loads attached payloads per run; they are part of the deployment artifact
   digest and are uploaded to `node_modules/<packageName>/` in the runtime.
5. **Agent context.** `GET /api/projects/:projectId/agent-context` returns a
   prompt suffix for host-side builders. Harnesses stage each plugin's README
   and types under `<pluginDirectory>/_plugins/<slug>/` with
   `stagedPluginFiles` and prepend `buildPluginsPreamble()`.

## First debug stops

| Symptom | Likely cause |
| --- | --- |
| `503 Plugins not configured` | No `pluginResolver` passed to `createCatamorphic`. |
| Plugin missing from the catalog | Invalid manifest (see `packages/plugins/src/manifest.ts`), not built, or not an immediate child of `rootDir`. |
| `400` naming missing secrets (`PluginSecretsMissingError`) | Required secret has no stored value, default, or capability provider. |
| Module not found at run time | Package not built, wrong `name`, or payload files missing from the deployment. |
| Agent invents plugin APIs | Docs or `.d.ts` not staged for the selected harness, or the manifest `docs` paths are wrong. |

## Files to read before changing the flow

- `packages/plugins/src/manifest.ts`, `packages/plugins/src/resolver.ts`
- `packages/fastify-plugin/src/routes/plugins.ts`
- `packages/core/src/services/plugins-service.ts`, `secrets-service.ts`,
  `run-plugins-loader.ts`, `agent-context-service.ts`,
  `deployment-artifacts-service.ts`, `deployment-runtime-service.ts`
- `packages/sandbox/src/plugin-upload.ts`,
  `packages/sandbox/src/coding-agent/plugin-staging.ts`
- The harness adapter in `packages/ai-sdk`, `packages/claude-code`, or
  `packages/codex`
