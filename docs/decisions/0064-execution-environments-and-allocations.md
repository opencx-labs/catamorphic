# 0064: Execution Environments and immutable Allocations

- **Status:** Accepted
- **Date:** 2026-08-23
- **Refines:** 0033, 0038, 0047
- **Agent placement model superseded by:** 0067
- **Missing project policy refined by:** 0070

## Context

Catamorphic selected one sandbox provider at host boot and described coding
agents as either `host` or `sandbox`. That is insufficient for projects that
may run across several servers, route work onto a pool, enforce different
isolation and resource policies, or keep an agent process inside the sandbox.
The word environment was also already used for the unrelated test and
production project-secret namespace.

## Decision

An **Environment** is the project-facing logical execution, isolation,
resource, and authority target. A committed project manifest declares logical
Environment names and host binding keys. The host injects the corresponding
Environment bindings, including their workload kinds, trust, isolation,
capabilities, resource ceiling, supported agent topologies, and runtime
provider. Project and role policy may narrow a binding but cannot supply
endpoints, provider objects, or credentials.

A **WorkerNode** is a physical machine eligible to execute work. It is not an
Environment. The initial implementation uses static single-node bindings; a
later scheduler may select a WorkerNode from a pool without changing project
configuration.

Every new agent session and root workflow run resolves one immutable
**Allocation** before execution. The Allocation records the Environment,
binding, workload, effective policy snapshot, and eventual WorkerNode.
Sessions remain sticky to their Allocation. Child workflows inherit the root
Allocation. Policy changes affect new Allocations rather than rewriting
history.

Agent process placement uses four topologies: `controller`, `contained`,
`native`, and `external`. The previous `host | sandbox` vocabulary is removed.
Native execution requires explicit support from the selected binding.

Scoped identities require a role grant for the selected Environment. Builder
status alone does not grant managed compute. Root host identities retain their
host-defined authority.

The test and production project-secret namespace is renamed **RunStage** with
the values `test | production`. It is not an Environment.

Credentials remain in the control plane. Environment and Allocation records
may describe broker reachability and trust requirements but never contain
provider credentials. Credential admission and capability grants are defined
in ADR 0065.

## Consequences

Hosts can expose one or many logical execution choices while preserving one
portable project model. Sessions and runs become explainable after placement
or policy changes. Static desktop and stock-server deployments pay only the
cost of an explicit binding, while future pools can add registration,
heartbeat, leases, and scheduling behind the same contracts.

The greenfield cutover changes public names, APIs, schemas, and committed
project configuration without compatibility aliases.
