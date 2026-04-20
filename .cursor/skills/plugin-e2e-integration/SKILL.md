# Plugin E2E Integration (Business-Agnostic)

## Use This Skill When

Use this skill when you need to integrate, debug, or document how an external workflow plugin package is discovered, attached, configured, and executed end-to-end in Catamorphic.

## Scope

This guide is intentionally domain-neutral. It applies to any plugin package that follows the Catamorphic manifest contract, regardless of vendor or business use case.

## System Components

- `packages/plugins` — Manifest schema + resolver implementations.
- `packages/server` — Catalog/attach/secrets APIs, run plugin loader, agent context.
- `packages/sandbox` — Workspace upload, plugin file mirroring, execution env.
- `packages/runtime` — Harness that executes the workflow.
- `apps/playground` — UI for attach/secrets and run initiation.
- `packages/db` — Persistent state for attached plugins and project secrets.

## End-to-End Runtime Sequence

1. A plugin package is made available to the resolver source (local directory in v1).
2. Resolver discovers plugin and validates `package.json.catamorphic`.
3. User attaches plugin to a project.
4. User saves required plugin secrets for the project.
5. User starts a workflow run from playground.
6. Server loads attached plugin metadata and files.
7. Server loads project secret values and validates missing required fields.
8. Server uploads workflow files and harness into sandbox workspace.
9. Server mirrors plugin files into sandbox `node_modules/<packageName>/`.
10. Server executes harness with merged env:
    - core run env (`CATAMORPHIC_*`)
    - plugin secrets (from `project_secrets`)
11. Workflow imports plugin exports and executes.
12. Run result is parsed and persisted by server.

## Required Setup and Configuration

### Database

- Apply migrations so plugin tables exist:
  - `project_plugins`
  - `project_secrets`

### Server

- Set `CATAMORPHIC_LOCAL_PLUGINS_DIR` for local resolver mode.
- Configure at least one sandbox provider:
  - Cloudflare provider env pair, or
  - Daytona API key.

### Playground

- Set `NEXT_PUBLIC_API_URL` to Catamorphic server.
- Set `OPENAI_API_KEY` if using AI workflow generation.

### Plugin package

- Include valid `catamorphic` manifest in `package.json`.
- Ensure built runtime artifacts exist before run (for example `dist/`).
- Ensure docs/types paths declared in manifest point to real files.

### Project-level

- Attach package through plugins API/UI.
- Provide all required secrets declared by manifest.

## Manifest Contract Essentials

Minimum expected fields:

- `catamorphic.displayName`
- `catamorphic.description`
- `catamorphic.secrets[]`
  - `name` in SCREAMING_SNAKE_CASE
  - `required`
  - optional `default`
- `catamorphic.docs.readme`
- `catamorphic.docs.types`

Validate against `PluginManifestSchema` in `packages/plugins/src/manifest.ts`.

## Failure Modes To Check First

1. `503 Plugins not configured`:
   - resolver not initialized, likely missing `CATAMORPHIC_LOCAL_PLUGINS_DIR`.
2. Plugin not visible in catalog:
   - manifest missing/invalid or path not under resolver source.
3. `Missing required plugin secrets`:
   - project secret values not set and no defaults for required entries.
4. Module resolution failure in sandbox:
   - plugin files not mirrored correctly or package not built.
5. AI-generated code invents APIs:
   - plugin docs/types were not staged into agent context.

## Verification Checklist

1. Catalog endpoint lists target plugin.
2. Attach endpoint succeeds and attached list includes plugin.
3. Secrets status endpoint shows required entries and `hasValue=true`.
4. Run succeeds with plugin import and function execution.
5. Sandbox workspace contains plugin under `node_modules/<packageName>/`.
6. Run report includes expected output and no secret/config errors.

## Files To Read Before Changing Integration

- `packages/plugins/src/manifest.ts`
- `packages/plugins/src/resolver.ts`
- `packages/plugins/README.md`
- `packages/server/src/routes/plugins.ts`
- `packages/server/src/routes/playground.ts`
- `packages/server/src/services/plugins-service.ts`
- `packages/server/src/services/secrets-service.ts`
- `packages/server/src/services/run-plugins-loader.ts`
- `packages/server/src/services/agent-context-service.ts`
- `packages/sandbox/src/run-executor.ts`
- `packages/sandbox/src/coding-agent/codex-agent.ts`
- `INTEGRATION.md`

