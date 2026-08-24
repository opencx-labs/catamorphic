# Credential Connections and Capability Brokerage Design

## Status

Approved in conversation on 2026-08-23 as the credential phase of the
Execution Environments architecture.

## Purpose

Let interactive members, durable workflows, and remote agents use Slack,
Google Workspace, MCP servers, and future providers without placing provider
credentials in a workload sandbox or confusing a member's delegated identity
with a project or tenant service identity.

This design covers the framework contracts, persistence, authorization
admission, host-side invocation path, policy model, and reference-host UX. It
does not claim that MCP or a connector registry removes an upstream provider's
OAuth application requirements. A provider still decides which OAuth client,
service account, installation, consent, and administrative setup it accepts.

## Terminology

- **Connection kind:** A host-registered implementation for one external
  system or protocol, such as an MCP server, Slack, or Google Workspace.
- **Connection:** Metadata for one authorized external principal. Its secret
  material lives in a host vault and is never stored in a project repository.
- **Principal:** The external identity represented by a Connection.
- **Member connection:** A delegated external identity owned by one member.
- **Project service connection:** A non-personal identity administered for one
  project.
- **Tenant service connection:** A non-personal identity administered for a
  tenant and explicitly assigned into projects.
- **Environment connection binding:** The project and Environment-local name
  that workload code uses, plus the provider, principal, connection, and
  capability rules for resolving that name.
- **Connection requirement:** An agent or workflow declaration naming a
  binding and the minimum capabilities and principal kinds it needs.
- **Credential vault:** A host-injected encrypted store for opaque provider
  material.
- **Connection broker:** The control-plane service that resolves bindings,
  intersects policy, refreshes credentials, invokes providers, and records
  audit events without returning provider secrets.
- **Capability grant:** A short-lived, allocation-bound authorization used by
  a workload to call the broker. It is not a provider credential.
- **Authorization attempt:** A short-lived state record for an OAuth, device,
  URL, or form authorization flow.

## Core invariants

1. A sandbox never receives a Slack token, Google refresh token, service
   account private key, MCP bearer token, OAuth client secret, or vault key.
2. Framework APIs grant the ability to perform a named action. They do not
   grant raw secret read access.
3. Member and service principals are explicit. A scheduled workflow never
   silently falls back to the member who last edited or enabled it.
4. Credential admission happens before Allocation creation and before any
   sandbox or agent process starts.
5. Agents and workflows use the same binding, broker, capability, audit, and
   revocation model. MCP and direct provider actions are transports behind the
   same authorization boundary, not different credential systems.
6. Project code may request a connection and narrow its reach. It cannot
   install credential material, choose an OAuth client secret, widen a host
   ceiling, or select an arbitrary external endpoint.
7. Privileged service connections stay in the control plane. Environments
   advertise isolation, trust, broker reachability, and which connection
   aliases are available, but never contain the credential itself.

## Connection records and secret storage

Core stores only non-secret metadata:

- tenant, optional project, and owner identity;
- connection kind and display label;
- principal kind: `member`, `project_service`, or `tenant_service`;
- authorization kind and lifecycle status;
- provider account/workspace/domain identifiers safe to display;
- granted capability names and provider scopes;
- expiry metadata and an optimistic revision;
- an opaque `credentialRef` naming material held by the host vault.

`CredentialVault` is injected into `createCatamorphic`. It stores and loads
opaque bytes by tenant and credential reference. Core never serializes the
plaintext into a database row, log, OpenTelemetry attribute, API response, run
record, allocation, or project file.

The desktop reference host implements the vault with Electron `safeStorage`.
The stock server implements an encrypted file vault under its data directory,
using a randomly generated 256-bit key stored in a separate mode-0600 file.
Other embedders may use KMS, HSM, Vault, cloud secret managers, or their own
envelope encryption.

Existing project secrets remain author-declared workflow configuration. They
are not the storage mechanism for OAuth tokens, service accounts, connector
headers, or other external identities.

## Connection kinds

Hosts register `ConnectionProvider` implementations at boot. A provider
declares:

- a stable kind name and display metadata;
- supported authorization methods;
- capability metadata and safe account summaries;
- optional authorization begin, completion, refresh, and revoke operations;
- host-side action invocation;
- optional MCP discovery and tool invocation.

The provider receives a narrow host-only credential handle. Provider material
may be decrypted only for the duration of a provider operation and must not be
returned through the broker result.

The first generic provider is remote MCP. It reuses `@catamorphic/mcp` OAuth
2.1 protected-resource discovery, authorization-server discovery, PKCE,
dynamic client registration when offered, pre-registered clients when
required, and refresh support. A plugin or embedder may register provider
implementations for Slack Web API, Google Workspace Admin SDK, or any other
direct API without changing the broker.

Registries distribute provider code and metadata. They do not confer the
provider's trust or eliminate registration. Slack and Google commonly require
an organization to create or configure an OAuth application, Slack app, Google
Cloud project, service account, domain-wide delegation, or an approved
publisher application. MCP dynamic client registration avoids a manual client
registration only when the MCP authorization server supports it.

## Environment connection bindings

A host administrator creates a binding for a project Environment. Workload
code sees only the binding's project-local name, for example `slack` or
`google_workspace`.

A binding contains:

- project id, Environment name, and alias;
- connection kind;
- allowed principal kinds;
- allowed provider capabilities;
- an optional assigned project or tenant service connection;
- whether a member-specific connection may be attached.

A member authorizes a binding in a specific Environment. The resulting member
connection attachment is keyed by tenant, member, project, Environment, and
alias. Authorization on one Environment does not silently authorize another.
An administrator may deliberately reuse one service Connection across several
bindings, but each assignment is explicit and auditable.

## Workload declarations

Agent definitions and workflow definitions declare requirements using logical
binding names. A requirement includes:

- `alias`;
- required capabilities;
- a public `member`, `service`, or `either` principal intent;
- whether it is optional.

String connection entries are shorthand for a required Environment binding
with no capability widening. Detailed requirements use the structured form.
Workflow definitions add a top-level
`connections` property beside `steps`, `triggers`, and controls. The parser
extracts only constant metadata from the TypeScript source and carries it into
the deployed workflow artifact.

Connection requirements participate in project-agent consent hashing. A
requirement that asks for a new binding, principal intent, or capability
requires new consent.

## Identity and policy intersection

Effective authorization is the strictest intersection of:

1. provider-side granted scopes and capabilities;
2. the Environment connection binding's capability allowlist;
3. the project role's connection refs;
4. the agent or workflow requirement;
5. the caller-bound session or workflow identity scope;
6. the current Allocation's immutable connection snapshot;
7. the per-tool or per-action runtime permission decision.

Project roles gain `connections` refs with binding aliases, Environment names,
principal kinds, and capabilities. Builder status does not imply
service-connection use. Managing project or tenant service
connections is a host control-plane permission supplied by the embedder and
is not granted by a repository role file.

No layer can widen another. Denial is checked again on every broker call so a
revocation or policy edit affects the next action without restarting an agent.

## Admission and authorization UX

Admission resolves the Environment first, then all connection requirements,
before recording an Allocation.

For an interactive member:

- a ready connection proceeds;
- a missing, expired, or revoked personal connection returns HTTP 428 with a
  structured `authentication_required` body;
- the client opens the Environment's connection flow;
- completion updates the connection and the client retries the original
  session or run request;
- no partial session, run, allocation, or sandbox is created before success.

Authorization attempts carry random state, actor, tenant, project,
Environment, binding alias, redirect metadata, expiry, and a single-use
completion status. State is hashed at rest. Redirects and completions validate
the same authenticated actor and binding.

For schedules, webhooks, and other unattended triggers:

- the trigger binding must name an Environment;
- each non-optional requirement must resolve to an assigned service Connection
  selected while the trigger is configured;
- enablement fails with a structured configuration error when it cannot;
- the runtime never borrows whichever personal connection happens to exist.

If authorization expires mid-run, the broker records an action-required event.
Interactive agents receive a typed tool failure and an auth card. Durable
workflows pause at the connection-call boundary and may resume after
reauthorization; they do not restart completed boundaries.

## Brokered actions and MCP

Workflow code calls `context.connections.<alias>.<action>(args)`. The runtime
emits a durable `connection_call` transition. Core attaches the run's caller,
allocation, workflow, and binding requirement, then asks the broker to invoke
the provider. The provider result becomes the next boundary input. Retries are
recorded with a stable invocation id so provider adapters can add idempotency
keys where supported.

Agents receive one Catamorphic MCP gateway per resolved binding, not the
provider's token-bearing MCP configuration. The gateway advertises the
provider's tools, applies the existing layered tool policy, and forwards calls
through the same broker. Tool names and annotations remain provider-derived.

An untrusted agent process authenticates to the gateway with a random,
short-lived capability grant. Only the SHA-256 hash is persisted. The grant is
bound to one Allocation, member identity snapshot, agent or workflow, binding
set, and expiry. It is revoked when the allocation is released, the session is
deleted, the related connection is revoked, or the host invalidates it. The
token permits broker calls only and cannot be exchanged for provider
credentials.

Native and controller agents also use the gateway. Uniform routing prevents a
future topology change from accidentally switching from brokered use to raw
credential injection.

## Service connections and local execution

The project Environment declaration and agent requirements express minimum
trust, isolation, topology, and resource constraints. A binding for a
tenant-wide Google Workspace administrator is exposed only in an Environment
whose host binding and role grants are appropriate, with a narrow capability
set. There is no separate untyped connection-policy blob.

The service credential remains usable by the control-plane provider only. A
workflow sandbox may run locally only when its Environment admission succeeds,
the member may use the binding, and the action still crosses the broker.

## Lifecycle, rotation, and audit

Connections have explicit `pending`, `ready`, `expired`, and `revoked`
states. Refresh uses optimistic revision checks so two workers do
not overwrite rotated material. Revocation invalidates grants first, calls the
provider's revoke hook when available, deletes vault material, and retains a
non-secret tombstone for audit.

Every authorization attempt, binding assignment, capability decision, action
call, refresh, failure, and revocation writes an append-only audit event with:

- actor and external principal kind;
- tenant, project, Environment, Allocation, session or run;
- connection and binding identifiers;
- provider, action or tool name, decision, status, and timing;
- a canonical input digest, never raw arguments by default;
- a sanitized provider error class.

Credential values, authorization codes, refresh tokens, private keys, headers,
request bodies, and provider responses are excluded from logs and telemetry.

## Reference providers and delivery boundary

This phase implements the generic broker, MCP provider, and reference-host
vaults and UI. It also defines typed provider seams and fixtures that model:

- a Slack member OAuth or bot/service principal;
- a Google Workspace member OAuth principal;
- a Google Workspace service account with delegated administrator subject.

Actual vendor applications require deployment-owned client ids, redirects,
verification, Slack installation, and Google Workspace administrative consent.
Those values cannot be supplied by the open-source framework. Vendor-specific
action packages can be added behind the same `ConnectionProvider` contract
without exposing credentials or revising the Environment model.

## Delivery sequence

1. Execution Environment and Allocation foundation.
2. Credential vault, connection metadata, providers, and lifecycle.
3. Environment bindings, role scope, and pre-allocation admission.
4. Workflow connection declarations and durable broker calls.
5. Agent MCP gateways and short-lived capability grants.
6. Desktop and stock-server authorization and management surfaces.
7. Revocation, pause/resume, audit, documentation, and full verification.
