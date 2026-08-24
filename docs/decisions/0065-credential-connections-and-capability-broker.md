# ADR 0065: Credential connections and capability broker

- **Status:** Accepted
- **Date:** 2026-08-23

## Context

Agents and workflows need external systems as either a member or an unattended
service identity. Provider credentials must not enter project code, workflow
inputs, sandboxes, harness configuration, allocations, logs, or API responses.
OAuth registries improve discovery, but do not remove provider application
registration and administrator approval requirements.

## Decision

Hosts inject an opaque `CredentialVault` and `ConnectionProvider`s. Core
persists only sanitized metadata and a vault reference. Connections have an
explicit `member`, `project_service`, or `tenant_service` principal. Project
Environments bind logical aliases to provider kinds and permitted principals.

Environment admission resolves connection requirements before compute is
allocated. Missing member authorization produces a structured
`authentication_required` response. Unattended work uses service connections
only, as refined by ADR 0066.

The first validated scan of a deployed trigger binding is its enablement
boundary. It freezes the selected Environment and exact service connection
ids. Later dispatches revalidate that snapshot and never select a replacement
principal implicitly. Changing an assignment requires a new deployed
projection.

Provider operations execute in the control plane through a broker. Each call
is bound to the caller, project, Environment, allocation, alias, action, and
live policy. Credential material is opened only inside the provider call and a
sanitized audit event is recorded. Agents receive short-lived,
allocation-bound grants for Catamorphic MCP gateways, never upstream secrets.

Projects and roles may declare requirements and narrow capabilities. Only the
host can configure OAuth clients, provider endpoints, service identities,
vaults, and policy ceilings.

## Consequences

- Slack and Google Workspace still require deployment-owned OAuth apps,
  service accounts, or administrator grants.
- Generic MCP OAuth reuses protocol machinery and registries, but cannot
  substitute for provider registration.
- `project_secrets` remain workflow configuration, not provider identities.
- Revocation and expiry are checked on every broker call and grants fail
  closed.
- Durable workflow calls park on typed authorization expiry and resume the same
  job after service credential rotation.
- Historical audit metadata remains after credential deletion.
