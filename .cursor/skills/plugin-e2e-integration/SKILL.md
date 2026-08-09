# Plugin E2E Integration (Business-Agnostic)

## Use This Skill When

Use this skill when you need to integrate, debug, or document how an external workflow plugin package is discovered, attached, configured, and executed end-to-end in Catamorphic.

## Scope

This guide is intentionally domain-neutral. It applies to any plugin package that follows the Catamorphic manifest contract, regardless of vendor or business use case.

## Canonical Docs

- `packages/plugins/README.md` (deep reference and troubleshooting)
- `INTEGRATION.md` (host integration quick guide)

## Quick E2E Checklist

1. Ensure plugin resolver is configured (`CATAMORPHIC_LOCAL_PLUGINS_DIR`).
2. Ensure plugin package has valid `catamorphic` manifest and built artifacts.
3. Attach plugin to project.
4. Save required project secrets.
5. Run workflow (host app UI or run API).
6. Verify plugin files exist in sandbox `node_modules/<packageName>/`.
7. Verify run result/report is persisted without missing-secret or resolution errors.

## First Debug Stops

1. `503 Plugins not configured`:
   - resolver/services not initialized (check server env and startup wiring).
2. Plugin missing from catalog:
   - invalid manifest or plugin not in resolver source path.
3. Missing required secrets:
   - secret not set and no default for required manifest entry.
4. Sandbox module resolution failures:
   - plugin not built or upload path mismatch.
5. AI usage mismatch:
   - plugin docs/types not staged into agent context.

## Files To Read Before Changing Integration

- `packages/plugins/src/manifest.ts`
- `packages/plugins/src/resolver.ts`
- `packages/plugins/README.md`
- `packages/fastify-plugin/src/routes/plugins.ts`
- `packages/fastify-plugin/src/routes/playground.ts`
- `packages/core/src/services/plugins-service.ts`
- `packages/core/src/services/secrets-service.ts`
- `packages/core/src/services/run-plugins-loader.ts`
- `packages/core/src/services/agent-context-service.ts`
- `packages/sandbox/src/run-executor.ts`
- `packages/sandbox/src/coding-agent/codex-agent.ts`
- `INTEGRATION.md`

