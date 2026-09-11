# 0133: Lean agent tool surface

- **Status:** Accepted
- **Date:** 2026-09-11
- **Refines:** 0101, 0103, 0111, 0124, 0125, 0126

## Context

Desktop agents receive overlapping workspace, project and connector tool
catalogues alongside native execution. Permanent recipes and cosmetic calls
consume context even when the task only needs ordinary files and code.

## Decision

Use native execution and skills for ordinary authoring, configuration, component
installation and local inspection. Host-owned state, identity, secrets, durable
execution and live UI remain service operations. Offer infrequent operations
through the existing capability registry, with one discovery/invocation pair per
session. Session-specific sources share that registry's live authorization,
Allocation fencing, validation and telemetry. Discovery never grants authority.

Keep a small direct host surface for questions, visible progress and presenting
results. Interactive browser/terminal operations must retain media, cancellation
and user takeover. Native shell stays available. Host ownership of todos and
delegation is explicit rather than inferred from eager tool names.

Internal desktop agents and external project MCP consumers use projections of
the same operations. Avoid duplicate skill loaders, messaging interfaces and
gateway mounts. Preserve public MCP contracts without duplicating implementations.
App presentation is deferred; creation can set the initial title and semantic
icon. Preview, publication and workflow activation are explicit operations.
Review evidence, composition and component installation belong in skills/code.

## Consequences

New tools must explain why files/code or an existing capability are insufficient.
Permanent schemas require a demonstrated interaction benefit. Inventory tests
measure exposure and instructions; scenario tests cover discovery, permissions,
media and workflow execution. Hosts retain control of policy and skill doctrine.
