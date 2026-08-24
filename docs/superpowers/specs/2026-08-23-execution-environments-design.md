# Execution Environments Design

## Status

Approved in conversation on 2026-08-23.

## Purpose

Make Environment the project-facing execution, isolation, resource, and
authority boundary for agent sessions and workflow runs. An Environment is a
logical contract. It may resolve to one local runtime today or route an
allocation onto a compatible WorkerNode from a pool later.

## Vocabulary

- **Environment:** A project-visible logical execution policy and routing
  target.
- **Environment binding:** A host or tenant administrator's realization of a
  project Environment. It supplies the actual execution capabilities and
  policy ceiling.
- **WorkerNode:** One physical server or machine eligible to receive
  allocations. A WorkerNode is not an Environment.
- **Allocation:** The immutable decision that binds one agent session or root
  workflow run to an Environment, effective policy, and eventually a
  WorkerNode and sandbox.
- **Server connection:** A desktop client's authenticated connection to one
  Catamorphic control plane. It is not an Environment.
- **RunStage:** The existing `test | production` namespace used for project
  secret values. This replaces the overloaded name `SecretEnvironment`.

## Authority split

Projects may declare logical Environment names, workload restrictions,
resource requests, and defaults. Project roles may grant members use of those
logical names. Project code cannot name arbitrary WorkerNode endpoints,
provide credentials, weaken isolation, or widen a server policy.

The host or tenant administrator supplies Environment bindings. A binding
owns the actual WorkerNode pool, sandbox provider, trust classification,
resource ceiling, supported agent topologies, connection broker, and placement
policy. Project requirements and binding capabilities are intersected. The
stricter result wins.

The host-facing provider returns an internal runtime binding containing the
public descriptor plus the actual `SandboxProvider`. API discovery receives
only the descriptor. This makes sandbox selection Environment-specific from
the first single-node implementation without exposing provider objects or
credentials to projects and clients.

The control plane owns admission, allocation, durable run and session state,
and auditing. Desktop, web, and mobile clients may request an Environment but
never select a physical WorkerNode.

## Project configuration

The committed `.catamorphic/project.json` manifest is the source of project
Environment declarations. Each declaration has a project-local name and a
host binding key. A missing binding makes the Environment visibly unavailable
rather than silently falling back.

```json
{
  "environments": {
    "local": {
      "binding": "local",
      "description": "Run on this desktop",
      "workloads": ["agent", "workflow"]
    },
    "company": {
      "binding": "managed-standard",
      "description": "Managed company execution",
      "workloads": ["agent", "workflow"]
    }
  },
  "defaultEnvironment": "local"
}
```

The framework does not synthesize a missing project declaration by guessing
at infrastructure. Project creation seeds the host's chosen default
declaration, and older projects receive an explicit migration during the
greenfield cutover.

## Role grants

Role definitions gain an `environments` list. A scoped member may use only the
listed project Environments. Environment grants are separate from artifact
scope: being a project builder does not implicitly grant managed compute or
service authority.

Root host identities remain unrestricted because they are the host's trusted
administrative identity. A scoped identity without Environment grants cannot
start a new agent session or root workflow run.

## Agent compatibility

Agent definitions express requirements rather than normally pinning one
Environment. Their Environment policy may include:

- `allowed`: exceptional exact-name allowlist;
- `preferred`: ordered project Environment preferences;
- minimum trust classification;
- required agent execution topology;
- required named capabilities;
- minimum CPU, memory, storage, or GPU resources.

The selected Environment must be allowed by the member, project, agent,
binding, and current host policy. Exact Environment pins remain available for
compliance-sensitive agents, but capability requirements are the portable
default.

Environment policy participates in the project-agent consent hash. Changing
where an agent may execute or what authority it requires invalidates prior
personal-credential consent.

## Agent execution topologies

The current `host | sandbox` execution vocabulary is replaced because it
conflates agent-process placement with tool isolation:

- `controller`: the agent loop runs in the control plane and operates on a
  sandbox workspace;
- `contained`: the agent loop, tools, and workspace run inside the allocated
  sandbox;
- `native`: the agent and tools run directly on the WorkerNode filesystem;
- `external`: an ACP or other remote agent runtime owns the agent process.

The existing built-in AI SDK agent becomes `controller`. Existing Claude Code
and Codex direct-filesystem harnesses become `native`. `contained` is added in
a later plan. Native execution is admitted only when the Environment binding
explicitly supports it.

An agent session resolves one Allocation before its first turn and remains
sticky to it. Moving a session creates a new allocation and re-anchors the
provider; it is never a silent mid-turn scheduler decision.

## Workflow allocation

Root workflow runs resolve an Environment during admission, before queueing or
sandbox creation. Child runs inherit the root allocation. Scheduled and
triggered runs use an explicit configured Environment or the committed project
default; they never infer an interactive member's personal Environment.

The initial foundation allows callers and triggers to select a project
Environment and persists the allocation. Workflow-authored capability and
connection requirements are added with the credential-broker phase so one
declaration controls both admission and authorization.

## Allocation record

Every allocation records:

- tenant and project;
- project Environment name and host binding key;
- workload kind and root workload id;
- effective trust, topology, capabilities, and resource policy snapshot;
- WorkerNode id when one has been selected;
- creation and release timestamps.

Agent sessions and workflow runs reference the allocation. The snapshot makes
historical execution explainable even after project or host policy changes.
Changing policy affects new allocations, never mutates a running workload's
record.

## Credential admission and brokering

Credentials are not part of the foundation implementation, but Environment
contracts reserve the boundary for them.

A later credential-broker plan adds connection requirements and two member
modes:

- interactive member authorization before a manual run;
- durable, revocable delegation when enabling a scheduled run.

Missing personal authorization produces a structured `requires_auth`
admission result before sandbox allocation. Service connections remain in the
control-plane broker. Workload sandboxes receive only short-lived,
run-specific capability tokens, never Slack, Google, or model credentials.

Privileged service connections may require both brokered execution and a
managed, isolated Environment. Local rejection is expressed by compatibility
requirements, not by comparing an Environment name to the string `local`.

## Worker pools

The foundation ships with static single-node bindings. A later scheduler plan
keeps the same Environment and Allocation contracts while adding:

- stable WorkerNode identities and capability descriptors;
- registration, heartbeat, and draining;
- resource-aware placement and leases;
- session affinity and workflow recovery;
- short-lived workload capability credentials;
- node-version compatibility and audit events.

The control plane remains canonical. WorkerNodes execute allocations but do
not own the authoritative session transcript, workflow run state, role policy,
or long-lived provider credentials.

## T3 Code influences

Catamorphic adopts T3 Code's useful separation of stable runtime identity,
access method, launch method, advertised capability descriptors, scoped
authorization, and client-side connection supervision. Catamorphic does not
adopt T3's equation of one Environment with one server or its environment-local
thread ownership. In Catamorphic terms, T3's ExecutionEnvironment is closest
to a WorkerNode plus a server connection.

## Delivery sequence

1. Environment foundation and terminology cutover.
2. Connection broker, structured authentication admission, and capability
   tokens.
3. Contained agent runtime using model and capability gateways.
4. Multi-node worker registration, leases, and pool scheduling.

Each stage must remain usable with a static single-node binding and must leave
the repository's full verification suite green.
