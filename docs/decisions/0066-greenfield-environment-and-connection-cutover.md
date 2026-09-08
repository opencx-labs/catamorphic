# ADR 0066: Greenfield Environment and connection cutover

- **Status:** Accepted
- **Date:** 2026-08-24
- **Service-only unattended rule superseded by:** 0068

## Context

The first Environment and credential-broker implementation retained optional
execution paths and reused desktop profile connectors for project agents. It
also exposed environment-conditional connection requirements, an untyped
binding policy blob, and durable member delegation for unattended triggers.
There are no production users, so preserving these parallel paths would add
ambiguity without buying compatibility.

## Decision

Every agent session and root workflow run is admitted to an Environment and
receives an immutable Allocation. Hosts must provide an `EnvironmentProvider`.
Project agents and workflows use only Environment-brokered connections;
desktop profile connectors remain a local profile-agent facility.

Workload connection requirements express an alias, `member | service |
either` principal intent, optional capabilities, and optionality. Project
versus tenant service scope remains host administrative metadata, not project
authoring vocabulary. Requirements are not conditional on Environment names:
the selected Environment resolves the alias.

Connection aliases are stable slugs containing letters, numbers, underscores,
and hyphens. They are never normalized. This keeps workflow properties,
authorization bindings, MCP server keys, and tool policy keys one-to-one.

Unattended triggers require service connections. Member connections are only
admitted for member-initiated work. The binding's untyped `policy` field is
removed; embedders narrow access through host-issued identity scope, typed
capability allowlists, provider grants, and runtime tool permission decisions.

## Consequences

- Missing Environment configuration fails at host construction instead of
  silently using legacy execution behavior.
- A project agent cannot bypass broker auditing through a same-named desktop
  profile connector.
- Scheduled and webhook workflows cannot depend on a member who may leave or
  revoke access.
- Supporting Claude-style owner-bound scheduled delegation remains possible,
  but requires an explicit owner lifecycle and is deferred.
- Adding richer binding policy later requires a typed, enforced host seam.
