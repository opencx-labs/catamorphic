# ADR 0086: Provider-neutral workflow enablement connections

- **Status:** Accepted
- **Date:** 2026-09-03
- **Refines:** 0068 and 0076

## Context

Workflow enablement must work for every host connection, including MCP
servers, without building product-specific paths for Google Workspace, email,
or any future provider. The desktop already stores authenticated MCP server
configurations for coding agents, so asking a user to authenticate the same
server again would create two credential models for one authority.

Trigger subscriptions in workflow code are definitions, not authority. A
member joining a company must still explicitly consent to each unattended
workflow, or have it become eligible after all of its declared connections
have been authenticated.

## Decision

All unattended workflows use one `WorkflowEnablement` model. An enablement
pins the deployed commit, Environment, owner, exact connection records,
narrowed action capabilities, consent digest, and trigger activations.
Definitions parsed from TypeScript remain inert until referenced by an active
enablement. Every dispatch and brokered action revalidates current authority,
and failure suspends only that enablement without selecting another account.

Connection providers are generic. MCP is an ordinary connection provider, so
MCP credentials are sufficient for workflow steps that invoke MCP actions.
The desktop adopts enabled profile MCP configurations into its encrypted
connection vault and binds them by their existing server alias. This adoption
is local to that host; a remote server still requires its own connection.
Hosts may inject any provider and any normalized project-event source. No
email or Google Workspace concept exists in the framework contract.

Deployment updates never silently broaden authority. They mark existing
enablements as having an update available, and the owner reviews a fresh
consent digest before moving the pinned revision. Watchers use the same model
as temporary, expiring enablements.

## Consequences

New employees get independent enablements even when they share the same
workflow definition. Existing authenticated connections can make the
enablement review immediately ready, while missing connections produce the
ordinary provider authorization flow. Hosts must provide current member
identity resolution when their membership system lives outside Catamorphic,
and provider event ingestion remains host-owned.
