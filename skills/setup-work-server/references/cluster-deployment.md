# Machines: control plane, replicas, and workers

Use this for adding execution capacity or availability to a Work server (ADR
0164). Custom embedders keep their own identity, database, runtime bindings,
storage, and deployment.

## Choose the smallest topology that fits

| Situation | Topology |
| --- | --- |
| A person or a small trusted team | One Work server, PGlite, default execution. Nothing below applies. |
| More agent capacity, or agents that must not run beside the server's secrets | One server (the control plane) plus enrolled **workers** |
| The brain must survive a machine failure | Control-plane **replicas** on shared Postgres, plus workers |

A worker holds only its own machine credential: no `DATABASE_URL`,
`WORK_SECRET`, `WORK_VAULT_KEY`, member tokens, or connection credentials.
A replica holds all of them, so only machines you would trust with the whole
brain become replicas. Never add a replica just for capacity.

## Add a worker

1. On the control plane, create a single-use enrollment code on the loopback
   operator listener (port 4701) with the operator bearer:
   `POST /_work/operator/workers` with `{ "name": "build-1" }`. Names are
   lowercase letters, digits, and dashes. The code expires in 30 minutes.
2. On the worker machine, run the same image version with the worker command
   and its own empty data volume:

   ```bash
   docker run -d --name work-worker -v work-worker-data:/data \
     -e WORK_CONTROL_PLANE_URL=https://brain.example.com \
     -e WORK_WORKER_ENROLLMENT=<code> \
     -e WORK_SANDBOX=microsandbox -e WORK_MAX_WORKSPACES=4 \
     <work-server image> bun apps/server/src/worker.ts
   ```

   Pass the code through the deployment's secret mechanism; it is needed only
   for the first start. The worker stores its credential in
   `/data/worker-credential` (owner-only) and refuses to start if
   `DATABASE_URL`, `WORK_SECRET`, or `WORK_VAULT_KEY` is set. It dials out; open
   no inbound port.
3. Check `GET /_work/operator/machines` for `worker.build-1` with
   `available: true`, and `GET /_work/operator/workers` for its last contact.
4. Bind an Environment to it in `.catamorphic/project.json`:
   `{ "binding": "workers", "workloads": ["agent"] }` for any worker, or
   `"binding": "worker.build-1"` for that machine. Grant the Environment in
   roles and prefer it in agent definitions through ordinary review.
5. Verify as a member: an agent command on that Environment runs on the worker.

Revoke a worker with `DELETE /_work/operator/workers/:name`; its credential and
node stop working at once. Re-enroll the same name with a new code.

Workers run agent sandboxes only. Workflow runs, which receive project secrets,
execute on the control plane. For developer and review agents use
`WORK_SANDBOX=microsandbox` on workers (see capacity below).

## Keep agent code away from the control plane

A company deployment should run agents on workers, not beside the control
plane's secrets. Set `WORK_CONTROL_PLANE_WORKLOADS=workflow` on the control
plane (or empty to run nothing locally). A Postgres control plane refuses to
start agents as plain subprocesses unless `WORK_SANDBOX=microsandbox` or the
operator sets `WORK_TRUST_CONTROL_PLANE_AGENTS=1` for a fully trusted team.

## Add a control-plane replica

1. Provision the same version with its own empty `WORK_DATA_DIR`; never copy
   another machine's identity or data volume.
2. Supply the deployment's `DATABASE_URL`, `WORK_SECRET`, `WORK_VAULT_KEY`,
   `WORK_PUBLIC_URL`, sign-in configuration (`WORK_AUTH_CONFIG`), and gateway
   configuration (`WORK_GATEWAY_CONFIG`) through the secret mechanism. All
   replicas share one public HTTPS origin behind the load balancer.
3. Start the normal server. Boot migrates with database coordination, checks
   that origin, secrets, vault key id, and sign-in configuration match, and
   registers its machine with a renewable lease.
4. Workers reconnect through the load balancer to any replica. If the replica
   holding a worker's lease stops, the lease lapses within about a minute and
   the worker's next connection moves it.

The operator can disable any machine with
`PATCH /_work/operator/machines/:id` and `{ "enabled": false }`. Lease fencing
blocks new claims and renewal of old execution ownership. Existing sessions do
not silently move to a different machine. Inspect uncertain actions and move a
settled session explicitly through its Environment update.

## Shared state and recovery

Network Postgres holds core state, Better Auth in its own schema, worker leases,
permission requests, runner jobs, project origin objects, deployment/app bundles,
and encrypted vault records. Neither `WORK_SECRET` (sign-in and notification
signing) nor `WORK_VAULT_KEY` (the credential vault) is stored in these records.
Back up the database and protect both secrets separately. Rotate the vault key
by moving the old key to `WORK_VAULT_PREVIOUS_KEYS`; see
[secrets and the gateway](secrets-and-gateway.md).

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

`WORK_GATEWAY_CONFIG` declares the connections the server brokers (MCP
endpoints, HTTP APIs, databases) and the guards that review them; see
[secrets and the gateway](secrets-and-gateway.md). This is host endpoint
configuration, not workflow logic or a second role model.
Commit project aliases and role capability grants separately. Members authorize
their own accounts and explicitly review each workflow before enabling it.

Verify cross-instance sign-in, PKCE exchange, refresh, approval replies, chosen
machine execution, role revocation, and checkpoint recovery with deterministic
fixtures. Verify the installed release's contracts before applying these steps.
Live provider checks and production deployment need authorization for those
external actions; never simulate enrollment through direct database writes.

## Capacity and isolated development

For developer agents on managed machines, use `WORK_SANDBOX=microsandbox`.
Install and verify the supported microsandbox runtime on that machine first;
Linux needs virtualization support and access to KVM. The stock Docker image
still defaults to trusted subprocess execution. Setting an environment variable
alone does not supply virtualization or turn that container into a per-agent
sandbox. Keep microsandbox's machine-local state on persistent storage.

Set these environment variables on each machine's service before starting it:

```dotenv
WORK_SANDBOX=microsandbox
WORK_MAX_WORKSPACES=4
WORK_CAPACITY_CPU_MILLIS=8000
WORK_CAPACITY_MEMORY_MB=16384
WORK_WORKSPACE_CPU_MILLIS=1000
WORK_WORKSPACE_MEMORY_MB=1024
WORK_SANDBOX_IMAGE=oven/bun
```

Capacity is an admission budget, not total machine RAM or CPU. Leave room for
Postgres (if colocated), the stock server, model controllers, builds, and the OS.
Defaults reserve one core and 1024 MiB per sandbox; the default machine budget
uses available CPUs minus one and 75% of host memory, with eight workspace slots.
Set explicit budgets in containers: OS memory reporting may describe the host.

Agent definitions reuse `environment.requirements.resources`; there is no second
agent resource configuration file. For example, merge this into an ordinary
`.catamorphic/agents/developer.json` definition:

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

Inspect `GET /_work/operator/machines` for budget, usage, and
`acceptingWork`; `GET /_work/operator/machines/:id/workspaces` identifies
retained allocations. Missing heartbeat or a cleanup error never frees capacity.
An ambiguous sandbox creation stays reserved too. Inspect the backend for the
`allocationId` label, stop and remove any matching sandbox, then use the
loopback-only `POST /_work/operator/machines/:id/workspaces/:allocationId/confirm-destroyed`
with `{ "confirmedDestroyed": true }` only after verifying physical cleanup.
The allocation must first be retired by closing/archiving/moving its session or
terminating its workflow. This is operator recovery, not a way to oversubscribe.
Do not switch a machine's sandbox backend while it still owns workspaces.

Member runners report their actual isolation and supported limits at registration;
This machine remains local trust even when it uses a VM. Unsupported requirements
are rejected before use, and requested limits travel with sandbox creation.

## Assign a development machine to one user

Use an ordinary named project Environment bound to the intended machine, and
an ordinary role granting that Environment to the selected member. Keep that
grant out of other roles; membership managers can grant it to additional members
when sharing is intended. No developer-owner machine type or separate assignment
permission exists. A grant controls admission, not OS accounts or network access.

Choose the trust boundary before provisioning. Control-plane replicas carry
the whole deployment's authority. Put developer machines in as workers (or as a
member's **This machine** runner); neither receives Postgres, vault, or
sign-in secrets. A private Environment grant alone does not make unrestricted
processes safe on a shared worker: use microsandbox for code you do not trust.

## Docker, development services, and private HTTP

Catamorphic does not require a team service manifest or parse Compose files.
Agents can run `docker compose up`, package scripts, or other ordinary commands
when their execution provider, harness permission mode, and host policy permit
those commands. Provision Docker Engine and dependencies on the actual command
target. Advertising a `docker` capability does not install Docker or grant access
to its socket. For sandboxed work, verify the selected backend/image supports the
needed daemon or containers; do not assume a host Docker socket is available.
Keep database volumes outside disposable checkouts and back them up through the
host's normal process. Archiving or moving a session can destroy its workspace.

The host owns HTTP routing and access protection. Bind a development service to
a private interface on its command target, then expose it through the host's
chosen private network, authenticated reverse proxy, or identity-aware gateway.
Tailscale is one host option, not a Catamorphic dependency. Configure its access
rules for the intended user and any explicitly permitted collaborators. If a
proxy handles authentication, configure it independently of the app's own login
and block direct access that would bypass it. Environment permission does not
automatically create a network rule. Do not publish an unprotected URL merely
because the service is on a developer's private Allocation.

Verify access as the owner, an allowed collaborator, and an unrelated user;
verify both the advertised endpoint and direct reachability. `localhost` refers
to the machine where the command executes, which can differ from the agent loop
or the user's browser. Record the reachable URL and access instructions through
the host's normal service inventory; a host capability can expose that inventory
to authorized agents. Catamorphic does not install tunnels or infer proxy rules.

## Updating machines

Use the host's service manager, container deployment, or existing orchestration.
Catamorphic does not ship a Kubernetes distribution or a second updater for
managed machines. Pin a release or image digest and keep replicas and workers
on the same version; do not assume arbitrary mixed-version operation is safe.
Update the control plane first, then workers; a worker keeps its credential and
data volume across updates.

1. Back up shared Postgres and verify recovery of the separately protected
   deployment secret. Review the release's migration and compatibility notes.
2. Stop submitting new work through the host's maintenance controls. Wait for
   turns and external actions to settle and verify their checkpoints. Inspect
   retained workspace processes and data that require persistence.
3. Disable the machine through the operator API before replacing its process.
   Disabling fences claims and lease renewal; it is not a graceful drain of
   running work. Never use it as evidence that an external action was undone.
4. Update the service/image while preserving that machine's own data volume and
   identity. Boot applies coordinated migrations. Re-enable the machine through
   the operator API and verify heartbeat, capabilities, and capacity before use.
5. Test sign-in, a permitted session, private HTTP access, and checkpoint
   persistence. Explicitly recover or relocate interrupted sessions. A service
   restart does not move a live process or promise automatic replay.

A package downgrade cannot undo forward-only database migrations. Follow the
release's recovery plan, which may require restoring the database and matching
application version. Hosts with unattended rollout requirements can automate
these existing controls in their own deployment system.
