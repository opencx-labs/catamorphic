---
name: plugin-e2e-integration
description: Use when integrating, debugging, or documenting discovery, attachment, configuration, sandbox staging, and execution of an external Catamorphic workflow plugin.
---

# Plugin E2E Integration (Business-Agnostic)

## Use This Skill When

Use this skill when you need to integrate, debug, or document how an external workflow plugin package is discovered, attached, configured, and executed end-to-end in Catamorphic.

## Scope

This guide is intentionally domain-neutral. It applies to any plugin package that follows the Catamorphic manifest contract, regardless of vendor or business use case.

## Canonical Docs

- `packages/plugins/README.md` (deep reference and troubleshooting)
- `INTEGRATION.md` (host integration quick guide)

## Quick E2E Checklist

1. Ensure the host explicitly configures a `PluginResolver`
   (`CATAMORPHIC_LOCAL_PLUGINS_DIR` is one reference-host input, not a
   framework switch).
2. Ensure plugin package has valid `catamorphic` manifest and built artifacts.
3. Attach plugin to project.
4. Save every required declared project secret for the production stage, or
   configure a host capability provider that supplies it.
5. Deploy the exact project commit, then trigger the workflow through the host
   UI or Run API.
6. Verify the immutable deployment artifact contains the plugin payload and
   its runtime materializes files under `node_modules/<packageName>/`.
7. Verify Run events and terminal state persist without missing-secret,
   capability-resolution, or module-resolution errors.

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
   - plugin docs/types are absent from `AgentContextService` or the selected
     coding-agent provider's staged plugin context.

## Files To Read Before Changing Integration

- `packages/plugins/src/manifest.ts`
- `packages/plugins/src/resolver.ts`
- `packages/plugins/README.md`
- `packages/fastify-plugin/src/routes/plugins.ts`
- `packages/core/src/services/plugins-service.ts`
- `packages/core/src/services/secrets-service.ts`
- `packages/core/src/services/run-plugins-loader.ts`
- `packages/core/src/services/agent-context-service.ts`
- `packages/core/src/services/deployment-artifacts-service.ts`
- `packages/core/src/services/deployment-runtime-service.ts`
- `packages/core/src/services/execution-worker-service.ts`
- `packages/sandbox/src/plugin-upload.ts`
- `packages/sandbox/src/coding-agent/plugin-staging.ts`
- The selected provider adapter in `packages/ai-sdk`, `packages/claude-code`,
  or `packages/codex`
- `INTEGRATION.md`
