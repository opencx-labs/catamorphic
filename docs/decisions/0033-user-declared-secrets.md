# 0033 — Projects declare their own secrets in code

- **Status:** Accepted
- **Date:** 2026-07-27
- **Expands:** 0001 (code is the source of truth), 0013 (test and production run modes)
- **Terminology refined by:** 0064 (`RunStage`, not Environment)
- **Provider identities refined by:** 0065 (use brokered connections)

## Context

Secret storage already existed end to end: `project_secrets` is keyed by
`(project_id, stage, name)` with separate test and production values,
`SecretsService.loadForRun` resolves values and defaults, and the resolved map
is injected into the run's process environment. Values are never read back over
the API — only presence metadata.

It was unreachable. Every entry point began with
`plugins.getDeclaredSecrets(projectId)` and returned empty when no attached
plugin declared anything, so `upsert` threw `UndeclaredSecretError` for any name
a user chose. A workflow calling a third-party API had no way to obtain a key
unless a plugin happened to declare it.

## Decision

A project declares its own secrets in code:

```typescript
export const secrets = defineSecrets({
  STRIPE_API_KEY: { description: "Stripe secret key" },
});
```

`defineSecrets` returns a typed accessor. Reading an unset secret throws
`MissingSecretError` naming the secret rather than yielding `undefined`, so a
misconfiguration fails at the point of use instead of surfacing later as a
confusing downstream error.

The parser discovers these declarations, and only from an inline object literal.
A declaration that cannot be read statically is a parse error rather than a
silent skip: the declared set gates which values may be stored, so failing
closed matters more than accepting every spelling.

The allowed set is the union of plugin-manifest declarations and project
declarations. Plugins win on name conflict, because the plugin's own code reads
the value and its manifest states the contract. `SecretsService` no longer
requires a plugin resolver.

**Secrets are backend-only.** They are never sent to a browser, never included
in an app bundle, and never readable through the app broker. An app that needs a
third-party API calls a workflow.

## Consequences

Secrets become usable without authoring a plugin, and declarations version with
the code that reads them. Secret listings now carry label, description,
required, and source so a host can render grouped forms.

Reading a secret throws where it is used rather than at run start; the existing
`missingRequired` check still surfaces missing required secrets up front.

Values remain plaintext at rest, as migration 007 noted for v1. Making secrets
directly user-facing raises the priority of encryption at rest, which remains
follow-up work.

Secret reads and writes now carry the caller's identity, which also closed the
missing tenant scoping on the secrets HTTP routes.
