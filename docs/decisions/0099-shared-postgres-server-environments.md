# 0099: Shared-Postgres server instances as managed Environments

- **Status:** Accepted
- **Date:** 2026-09-07
- **Refines:** 0064, 0067, 0071, 0095, 0098
- **Supersedes:** 0059's single-node storage assumption for managed multi-machine deployments

## Context

A company brain needs an easy way to add machines on which permitted members
can run agents. Independent servers with separate PGlite databases would split
identity, policy, connections, and history. Sharing a database alone does not
make process ownership or machine-local files safe across server instances.

## Decision

Managed machines run instances of the same Catamorphic server deployment. They
share one logical authority and public origin, and one network Postgres database
for durable application/auth state and coordination. Multiple instances must be
able to serve requests and execute work concurrently. PGlite remains supported
for standalone installs; it is not a shared cluster backend. This stock deployment
model does not replace a custom embedder's injected auth or infrastructure.

Use the existing Environment, runtime binding, WorkerNode, and Allocation
contracts. Machine setup enrolls an instance with a distinct identity and its
available execution capabilities. The host binds a project-facing Environment
to an enrolled machine or compatible pool. Projects and agents narrow role-granted
choices under ADR 0098; enrollment alone grants no project access. A selected
machine must be the machine that performs the work, with no silent fallback.

Instance identity and execution ownership are distinct from the shared authority.
Use Postgres claims, leases, and fencing for dispatch, recovery, schedules, and
other background work. Requests, OAuth callbacks, approvals, and observations
must work across API instances. Recovery must preserve acknowledged history and
must not blindly replay side effects after an uncertain outcome.

Authoritative project origins, deployed artifacts, and vault records must be
accessible to eligible instances through host-injected shared storage. Signing
and vault configuration must be consistent across the authority; keys remain
outside application tables. Local checkouts and runtime files are instance-owned
working state with explicit recovery semantics. Sharing a PGlite directory or
cloning a whole server data directory is not enrollment.

The desktop's **This machine** option remains an authenticated member execution
client of the project authority. It does not require Postgres credentials or
become a trusted server instance. Managed server enrollment is an operator task;
ongoing Environment grants remain ordinary reviewed project policy.

## Consequences

The stock Postgres host stores origins, bundles, and encrypted vault records in
Postgres through the generic ObjectStore contract. Signing keys derive from the
shared deployment secret, with separate derivation domains. Boot rejects an
inconsistent public origin, secret, or auth configuration. Machine-local caches
and sandboxes remain disposable working state. Each settled server-agent turn
pushes a session branch to the shared origin before acknowledging its checkpoint;
explicit relocation restores that branch without publishing it as project policy.

The core owns node leases, allocation admission, durable permission requests, and
member runner jobs. The SDK supplies Postgres object storage and the authenticated
client execution loop. The stock host supplies node enrollment and operator
inventory. Desktop supplies a sandbox and bearer transport. Generic object-store
git transport lives in `@catamorphic/git`; `@catamorphic/s3` supplies only its vendor
adapter. Shared connection review UI lives in `@catamorphic/ui`.

The stock host supports controller agents: the model loop runs on an admitted
server; a member runner executes its sandbox operations locally. Native CLI
runtimes remain a host-injected capability, never falsely advertised as stock
machine support. Runner leases pin local allocations to one connection lifetime;
a reconnect requires an explicit new allocation. Uncertain actions are never
automatically replayed. PGlite remains a one-process deployment.
