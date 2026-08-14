# 0046 — Plugin activation planes: capability providers and project lifecycle hooks

## Status

Accepted.

## Context

Embedders want per-project infrastructure — the motivating case is a database
per project (a fleet of server-side PGlites behind a wire-protocol gateway, or
thousands of managed Postgres instances provisioned via a vendor API). Doing
that **securely and reliably** needs three things the plugin subsystem
(ADR 0008, ADR 0033) could not express:

1. **Host-supplied run-time values.** Secrets were user-shaped: static
   plaintext rows a user typed into a form. A DB-per-project architecture
   wants the *host* to mint credentials — per project, per run,
   short-lived — with no long-lived connection string at rest.
2. **Provisioning tied to the project lifecycle.** Creating a project must
   provision its database; deleting it must deprovision. Wrapping
   `projects.create` host-side misses projects created over HTTP or by
   agents.
3. **A packaging story.** The sandbox half of an integration (client
   library, env declarations, agent docs) and the host half (credential
   minting, provisioning, trigger kinds) belong to one product and should
   ship as one npm package — without letting a UI click execute code in the
   host process.

## Decision

**A plugin is the unit of distribution. It has two activation planes: a
sandbox half activated by per-project attach, and a host half activated only
by boot-time registration. Run-time env resolves through one bindings chain:
capability provider → stored secret → declared default.**

- **Capability requirements.** A plugin manifest may declare
  `requires: [{ name: "acme.database", ... }]` (dot-namespaced, like trigger
  kinds). Attaching a plugin whose non-optional requirement has no registered
  provider fails closed with `UnfulfilledCapabilityError` — at attach time,
  not at run time.
- **Capability providers** are host code, built with
  `defineCapability({ name, resolve })` and registered at boot. At run
  launch, `resolve({ tenantId, externalUserId, projectId, environment, workflowName })`
  returns env values that are merged into the run's environment and **never
  persisted**. Provider values win over stored secrets, which win over
  manifest defaults — the host is a higher authority than a form field.
  Providers must not return `CATAMORPHIC_`-prefixed names.
- **Project lifecycle hooks** (`onProjectCreated`, `onProjectDeleted`) are
  host code registered at boot. `onProjectCreated` runs after the project
  row and repo exist; a throw rolls both back and fails the create
  (`ProjectProvisioningError`) — a project without its infrastructure never
  half-exists. `onProjectDeleted` runs *before* deletion; a throw aborts the
  delete (`ProjectDeprovisioningError`) — retryable, nothing leaks. Hooks
  must be idempotent; they follow the sync-trigger-firing precedent
  (ADR 0039) rather than a durable outbox, which remains future work if
  hosts need provisioning that survives process death mid-call.
- **`definePlugin` packages the host half**: capability providers, project
  hooks, trigger kinds, and MCP tool kinds under one name.
  `createCatamorphic({ plugins: [neonPlugin(config)] })` merges each
  plugin's contributions with the top-level config; duplicate capability or
  kind names across plugins fail at boot. The sandbox half stays exactly
  what ADR 0008 shipped: manifest + files attached per project. A vendor
  package exports its host half and ships its sandbox half — one install,
  one name, both planes.

The trust boundary this preserves: **attach** is a UI action any project
user can perform and only ever stages declarations and sandbox files;
**registration** is a deploy performed by the embedder's engineers and is
the only way code enters the host process.

## Consequences

- The DB-per-project architecture becomes expressible with zero
  Catamorphic knowledge of any vendor: the provider function is host code;
  workflows just read `process.env`.
- Secrets UI can render host-fulfilled bindings as "supplied by your
  platform" instead of a password field.
- `SecretsService` and the `project_secrets` table are unchanged; the chain
  extends resolution, it does not replace storage. Encryption at rest for
  stored values remains a follow-up (noted since migration 007).
- Capability requirements currently come only from plugin manifests. A
  project-code declaration (`defineCapabilities`, mirroring ADR 0033's
  `defineSecrets`) is anticipated but not built.
- Run-scoped context deliberately excludes a `runId`: providers resolve at
  launch, before the run row is the run's identity; per-run audit hooks can
  be added to the context later without breaking providers.
