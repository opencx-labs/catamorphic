# Managed machines and multi-instance deployments

Use this for adding stock-server capacity to one company brain. Custom embedders
keep their own identity, database, runtime bindings, storage, and deployment.

## Add a managed machine

1. Provision the same Catamorphic version on the machine. Give it its own empty
   `CATAMORPHIC_DATA_DIR`; never copy another machine's identity or data volume.
2. Supply the existing deployment's `DATABASE_URL`, `BETTER_AUTH_SECRET`,
   `CATAMORPHIC_PUBLIC_URL`, and auth configuration (`CATAMORPHIC_AUTH_CONFIG`).
   Use the operator's secret provisioning mechanism. All instances share one
   public HTTPS origin and network Postgres. PGlite is single-process only.
3. Set `CATAMORPHIC_MACHINE_NAME` to a recognizable name. Configure the same model
   and connection provider support on eligible execution machines. The built-in
   stock harness runs `builtin` project agents using the host's model credential.
   Explicit personal/profile/CLI credential definitions are unavailable there.
4. Start the normal stock server. Boot migrates with database coordination,
   checks deployment auth consistency, and registers the persisted machine id
   with a renewable lease. An already-live duplicate id fails startup.
5. Read `GET /_catamorphic/operator/machines` on the machine's loopback operator
   listener, using its operator bearer. The default operator port is 4701.
   Verify the new machine's id, label, availability, and execution capabilities.
6. Commit a named Environment in `.catamorphic/project.json` with that machine id
   as its `binding`. Grant the Environment through ordinary `roles/*.json` and
   narrow/prefer it in the relevant `agents/*.json` definition. Enrollment alone
   grants no member access. The `local` binding selects an available managed
   node at admission; a concrete machine id makes placement explicit.
7. Use an ordinary member identity to inspect `GET /projects/:id/agent-catalog`
   and `GET /projects/:id/environments?workload=agent&agentId=...`, then run the
   intended agent. Verify actual execution and connection access on that machine.

The operator can disable a machine with
`PATCH /_catamorphic/operator/machines/:id` and `{ "enabled": false }`.
Lease fencing blocks new claims and renewal of old execution ownership. Existing
sessions do not silently move to a different machine. Inspect uncertain actions
and move a settled session explicitly through its Environment update.

## Shared state and recovery

Network Postgres holds core state, Better Auth in its own schema, worker leases,
permission requests, runner jobs, project origin objects, deployment/app bundles,
and encrypted vault records. The deployment secret is never stored in these
records; separate keys are derived for auth, vault, and notification purposes.
Back up the database and protect the deployment secret separately. Do not change
that secret in place: restoring the original key is required to decrypt records.
A key-rotation migration must re-encrypt existing records before changing keys.

Each machine owns local checkouts and sandbox processes. Server agent sessions
checkpoint to isolated `sessions/<id>` branches in the shared origin. Relocation
reconstructs the workspace and model history; it does not migrate a live process
or publish session edits to project `main`. Failed checkpoint persistence is a
failed turn requiring recovery. Work not checkpointed before a machine is lost
remains uncertain and is never automatically replayed.

## A member's This machine

Declare a project Environment with `binding: "this-machine"`, workload `agent`,
and appropriate role grants. The desktop's **Connect This machine** action starts
an authenticated SDK runner using its local sandbox provider. It receives no
Postgres credentials. Discovery and every operation retain the member's current
project and Environment permissions. Closing the desktop or losing authorization
stops the runner. A new connection lifetime cannot revive an old allocation.

Stock local execution uses the controller topology: the host model loop and
connection broker stay on the server; sandbox commands and files run on the
member's machine. Native local CLI execution is not advertised by the stock host.
Do not call a controller sandbox a locally running model or promise offline use.

## Connections and verification

`CATAMORPHIC_CONNECTION_PROVIDERS_CONFIG` points to a JSON array of MCP provider
entries: `{ "kind": "company", "displayName": "Company tools", "url":
"https://tools.example.com/mcp", "transport": "http" }`. `sse` is also supported.
This is host endpoint configuration, not workflow logic or a second role model.
Commit project aliases and role capability grants separately. Members authorize
their own accounts and explicitly review each workflow before enabling it.

Verify cross-instance sign-in, PKCE exchange, refresh, approval replies, chosen
machine execution, role revocation, and checkpoint recovery with deterministic
fixtures. Verify the installed release's contracts before applying these steps.
Live provider checks and production deployment need authorization for those
external actions; never simulate enrollment through direct database writes.

## Capacity and isolated development

For developer agents on managed machines, use `CATAMORPHIC_SANDBOX=microsandbox`.
Install and verify the supported microsandbox runtime on that machine first;
Linux needs virtualization support and access to KVM. The stock Docker image
still defaults to trusted subprocess execution. Setting an environment variable
alone does not supply virtualization or turn that container into a per-agent
sandbox. Keep microsandbox's machine-local state on persistent storage.

Set these environment variables on each machine's service before starting it:

```dotenv
CATAMORPHIC_SANDBOX=microsandbox
CATAMORPHIC_MAX_WORKSPACES=4
CATAMORPHIC_CAPACITY_CPU_MILLIS=8000
CATAMORPHIC_CAPACITY_MEMORY_MB=16384
CATAMORPHIC_WORKSPACE_CPU_MILLIS=1000
CATAMORPHIC_WORKSPACE_MEMORY_MB=1024
CATAMORPHIC_SANDBOX_IMAGE=oven/bun
```

Capacity is an admission budget, not total machine RAM or CPU. Leave room for
Postgres (if colocated), the stock server, model controllers, builds, and the OS.
Defaults reserve one core and 1024 MiB per sandbox; the default machine budget
uses available CPUs minus one and 75% of host memory, with eight workspace slots.
Set explicit budgets in containers: OS memory reporting may describe the host.

Agent definitions reuse `environment.requirements.resources`; there is no second
agent resource configuration file. For example, merge this into an ordinary
`agents/developer.json` definition:

```json
{
  "environment": {
    "allowed": ["development"],
    "preferred": ["development"],
    "requirements": {
      "isolation": "sandbox",
      "resources": { "cpuMillis": 2000, "memoryMb": 4096 }
    }
  }
}
```

Microsandbox enforces whole-core CPU limits (multiples of 1000 millicores) and
memory in MiB. Disk and GPU limits are currently rejected by the stock providers.
Native host CLI execution does not enforce these sandbox limits; use controller
agents for this setup. The stock controller and connection broker remain outside
the VM. Agent command timeouts are bounded by `timeoutSeconds` when supplied.
The local-process backend has a workspace-slot budget but rejects CPU/memory
budgets; it is still for trusted single-tenant work only.

A managed session reserves its workspace at creation, including between turns.
Background development servers stay within the same VM and budget. Full machines
stop accepting new Allocations; already admitted sessions keep their placement.
Archive, close, or move unused sessions to retire their workspaces. Restoring an
archived session needs fresh admission. Workflow root allocations release on
termination. Cleanup runs on the owning node; capacity returns only after its
sandbox is destroyed. A stopped VM still has a reservation for safe restart.

Inspect `GET /_catamorphic/operator/machines` for budget, usage, and
`acceptingWork`; `GET /_catamorphic/operator/machines/:id/workspaces` identifies
retained allocations. Missing heartbeat or a cleanup error never frees capacity.
An ambiguous sandbox creation stays reserved too. Inspect the backend for the
`allocationId` label, stop and remove any matching sandbox, then use the
loopback-only `POST /_catamorphic/operator/machines/:id/workspaces/:allocationId/confirm-destroyed`
with `{ "confirmedDestroyed": true }` only after verifying physical cleanup.
The allocation must first be retired by closing/archiving/moving its session or
terminating its workflow. This is operator recovery, not a way to oversubscribe.
Do not switch a machine's sandbox backend while it still owns workspaces.

Member runners report their actual isolation and supported limits at registration;
This machine remains local trust even when it uses a VM. Unsupported requirements
are rejected before use, and requested limits travel with sandbox creation.
