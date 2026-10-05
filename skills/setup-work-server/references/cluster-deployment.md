# Machines: control plane, replicas, and workers

Use this for adding execution capacity or availability to a Work server
(ADRs 0164, 0167), including a machine for every employee. Custom embedders
keep their own identity, database, Environment provider, storage, and
deployment.

## Choose the smallest topology that fits

| Situation | Topology |
| --- | --- |
| A person or a small trusted team | One Work server, PGlite, default execution. Nothing below applies. |
| More agent capacity, or agents that must not run beside the server's secrets | One server (the control plane) plus enrolled **workers** |
| Each person or team gets their own machine | Workers with **access** lists, created by hand or by **machine rules** |
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
   Add placement in the same request (see [placement](#placement-labels-and-access)):
   `labels` (`{ "class": "gpu" }`), `access` (`{ "everyone": true }`, the
   default, or `{ "people": ["dana@example.com"], "groups": ["eng@example.com"] }`,
   or `{ "projects": ["<project id>"] }` for one project's own work),
   and `trusted`.
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
   for the first start. Every worker call states the worker's protocol; a
   control plane that cannot drive it answers `426` with
   `{ "code": "upgrade_required", "serverProtocol", "minimum" }`, and the
   worker logs which side to update and asks again every few minutes. Run
   workers of the control plane's release. The worker stores its credential in
   `/data/worker-credential` (owner-only) and refuses to start if
   `DATABASE_URL`, `WORK_SECRET`, or `WORK_VAULT_KEY` is set. It dials out; open
   no inbound port.
3. Check `GET /_work/operator/machines` for `worker.build-1` with
   `available: true`, and `GET /_work/operator/workers` for its last contact
   (its last call to any replica).
4. Nothing in projects changes: the `default` Environment already runs agents
   on any machine open to their owner. To reserve machines for some work, give
   them a label and select it in `.work/project.json`
   (`{ "pool": { "class": "gpu" }, "workloads": ["agent"] }`); `node` and
   `plane` (`control` or `worker`) are always set.
5. Verify as a member: `project_overview` shows the Environment runs agents,
   and an agent command runs on the worker.

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

The `default` Environment then puts workflows on the control plane (the only
machines offering workflows) and agents on workers, with no project change.
Label the control plane with `WORK_MACHINE_LABELS=pool=agents,class=large`
when an Environment should select it.

## Placement: labels and access

Every machine carries labels: the server's own `node` and `plane`, plus the
operator's. An Environment's `pool` selects machines whose labels all match.
Each worker also has **access**, which only the operator sets: everyone,
named people and directory groups by email, or named projects. The server
places a piece of work for its owner (the session's member). Project chats
and automation runs have no owner: they use machines opened to their project
(`"projects": ["<project id>"]`) and machines open to everyone, never a
person's machine. A machine opened only to projects takes no member's chat.

1. the owner's own machine (access naming only them), or for a project's own
   work a machine opened to that project alone,
2. then a machine shared with named people, their groups, or several projects,
3. then machines open to everyone.

A dedicated review pool for one project is a labelled worker opened to that
project: `{ "labels": { "pool": "review" }, "access": { "projects": ["<id>"] },
"trusted": true }`. The project selects it with an Environment
(`"review": { "pool": { "pool": "review" }, "workloads": ["agent"] }`) and its
reviewing agent prefers it (`"environment": { "preferred": ["review"],
"allowed": ["review"] }`). A workflow on the control plane that delivers to
that agent's chat places the chat on the review pool: each workload is placed by
its own Environment, so control-plane machines need no `review` label.

When the narrowest tier is full, work falls back to the next unless the
Environment sets `"strict": true`. A worker serving more than one person must
run `WORK_SANDBOX=microsandbox`; the control plane refuses to connect a
process-isolated shared worker unless the operator vouches for the people it
serves with `"trusted": true`. A machine opened to exactly one project counts
as serving one owner. Change placement with
`PATCH /_work/operator/workers/:name` (`labels`, `access`, `trusted`); it
applies to the next placement, and an existing session re-checks it on its
next turn.

Chats give their workspace back while they wait. An Environment's
`idleReleaseMinutes` (default 30, `0` keeps it) says how long a chat may go
without a turn before its sandbox is saved to its session branch and
destroyed, freeing the slot and CPU and memory reservation. The next turn
admits a fresh workspace and restores it. Closing a chat
(`close({ key })` from a workflow, `session_close` over MCP, or
`DELETE /api/projects/:id/agent/chats/:key`) releases the workspace for good,
deletes its session branch, and frees the key. Capacity follows activity,
not open chats.

Groups come from the Google Workspace directory (see [company
identity](company-identity.md)): the server checks the groups that access
lists, machine rules, and project role mappings name.

## A machine for every person or team

Machine rules create and destroy workers to match the directory. They need a
platform: extend the Work server with a `machineProvisioner` hook
(`create({ name, class, labels, enrollment })` returns a platform reference;
`destroy({ name, ref })` deletes the machine). A created machine starts the
worker command with `WORK_CONTROL_PLANE_URL` and the one-time
`WORK_WORKER_ENROLLMENT` code it received, for example through cloud-init.

- `PUT /_work/operator/machine-rules/desks` with
  `{ "group": "eng@example.com", "machines": "each-member", "class": "standard-4" }`
  gives every active member of the group their own machine.
- `PUT /_work/operator/machine-rules/support` with
  `{ "group": "support@example.com", "machines": { "shared": 3 }, "class": "small" }`
  gives the group three shared machines (add `"trusted": true` only for
  process-isolated machines among people who trust each other).
- `GET /_work/operator/machine-rules` lists rules; `DELETE` removes one and its
  machines; `POST /_work/operator/machine-rules/reconcile` runs a pass now.

The server reconciles every minute and when an account is disabled, one
replica at a time: a pass holds a lease in Postgres, renews it while platform
calls run, and stops changing anything once another replica took it over; a
machine whose enrollment code is still waiting is never provisioned twice.
Members who left the group or were suspended lose their machine (revoked,
then destroyed), and a machine that never enrolls within an hour is destroyed
and replaced. A person gets a machine after their first sign-in, once the
directory has placed them in the group.

## Add a control-plane replica

A replica on network Postgres is disposable (ADR 0190): everything durable
lives in Postgres or in its configuration, so any replica can be replaced by a
fresh one with an empty disk at any time.

1. Provision the same version with its own `WORK_DATA_DIR`. It may be empty
   and need not persist: it holds only session checkouts and sandboxes. Never
   share one data directory between two running replicas: a replica removes
   the sandboxes it finds there when it starts.
2. Supply the deployment's `DATABASE_URL`, `WORK_SECRET`, `WORK_VAULT_KEY`,
   `WORK_OPERATOR_SECRET`, `WORK_PUBLIC_URL`, sign-in configuration
   (`WORK_AUTH_CONFIG`), and gateway configuration (`WORK_GATEWAY_CONFIG`)
   through the secret mechanism. Boot refuses a Postgres deployment without
   `WORK_OPERATOR_SECRET`, since every replica must answer the same operator
   credential. All replicas share one public HTTPS origin behind the load
   balancer; set `WORK_MDNS=off`. Set `WORK_TRUSTED_PROXIES` to the balancer's
   (and any CDN's) addresses so sign-in limits count each person's address,
   not the balancer's; the limits are shared by every replica
   ([sign-in limits](stock-server.md#sign-in-limits)).
3. Start the normal server under a restart policy. Boot migrates with
   database coordination, checks that origin, secrets, vault key id, and
   sign-in configuration match, and registers a new machine
   (`node.<uuid>`, `plane=control`) with a renewable lease. The machine lives
   as long as the process: a restarted replica is a new machine.
4. Probe it. `/readyz` (readiness) answers 503 while its lease is not
   renewing, for example during a database failover, or while the machine is
   disabled; the balancer then routes around it. `/healthz` (liveness) answers
   503 only once the lease is lost, which is permanent (the database refused
   a renewal, or none landed for 45 seconds): the process then exits and its
   supervisor starts a fresh one. Never point liveness at `/readyz`:
   a database blip shorter than the 45 second lease would restart every
   replica. On Kubernetes, also set `terminationGracePeriodSeconds` to at
   least 30, so a stopping replica can let its chat turns finish (up to 15
   seconds) and move its work before it is killed. The image exits within 25
   seconds of SIGTERM whatever is still running.
5. Workers reach the replicas through the load balancer, and any replica
   answers any worker call (ADR 0187). A worker retries a failed call, such as
   a 502 or a replica restarting, without ending its session or interrupting
   its agents. Set the balancer's idle timeout above 30 seconds (a poll waits
   up to 20) and allow 64 MiB request bodies. A worker owns its lease (ADR
   0192): its own calls renew it, and any replica runs its agents. Stopping a
   replica affects only the turns that replica was running: a stopping
   replica lets them finish or interrupts them (see below), and a crashed
   one's are settled as interrupted by another replica once their turn lease
   lapses, about a minute later. The chats' next turns run on any replica. A
   worker that is away for more than 45 seconds is unavailable: its chats'
   turns wait, and in-flight operations its controllers stopped waiting for
   fail as uncertain. When it calls again, the same process simply carries
   on.
6. No replica keeps state another replica needs in memory (ADR 0193).
   Whether a chat is running, and whether it may be changed, comes from its
   turn's lease in Postgres, so every replica answers the same. An interrupt,
   close, or archive sent to any replica reaches the turn within about a
   second; a closed chat's workspace is given back only once its turn has
   stopped. One replica at a time publishes a project, creates a deployment
   runtime, or syncs a company project, under a claim in Postgres. A deploy
   applies on every replica at once: roles and program reads follow the
   published commit.

A restarted worker process connects under a new epoch. The operations it had
in flight fail as uncertain and are never replayed; its sandboxes and chats
carry on. Two processes must never share one worker's data volume: the older
one stops for good once the newer one connects. A new process whose clock is
behind its predecessor's waits up to 45 seconds for the old lease to lapse.

The operator can disable any machine with
`PATCH /_work/operator/machines/:id` and `{ "enabled": false }`. Lease fencing
blocks new claims and renewal of old execution ownership. A disabled
replica's lease lapses, its process exits, and its work is recovered like a
lost replica's. A disabled single server keeps running, answers 503 on
`/readyz`, takes no work, and resumes when its own operator API enables it
again. A disabled worker keeps its sessions: they do not silently move to a
different machine.

## Shared state and recovery

Network Postgres holds core state, Better Auth in its own schema, worker leases,
permission requests, runner jobs, project origin objects, members' program
drafts (refs in each project's origin, ADR 0191), deployment/app bundles,
and encrypted vault records. A member's draft is the same on every replica,
so any replica answers any `program_*` call, and replacing a replica loses
no draft. Neither `WORK_SECRET` (sign-in and notification
signing) nor `WORK_VAULT_KEY` (the credential vault) is stored in these records.
Back up the database and protect both secrets separately. Rotate the vault key
by moving the old key to `WORK_VAULT_PREVIOUS_KEYS`; see
[secrets and the gateway](secrets-and-gateway.md).

A replica that stops (SIGTERM) stops claiming work, returns its running
workflow jobs to the queue, lets its running chat turns finish (and
interrupts any still running after about ten seconds), gives its machine
back, moves its work to the other replicas at once, and removes its
sandboxes. A replica that dies is lost once its lease has lapsed
for 30 seconds (about a minute and a quarter after its last renewal). Every
replica checks for lost replicas every ten seconds and recovers their work:

- each workflow run, paused durable runs included, gets a workspace on a
  live replica in its own Environment. Its sandbox is rebuilt from the
  deployed commit and its step journal carries on; a step whose outcome was
  uncertain retries as after a restart. The run is placed for its owner
  with their current access, as a chat's next turn is. A run that no replica
  can take waits for one; a run whose Environment the project removed, or
  whose owner may no longer act, fails with the reason.
  Tenant run capacity is freed when the run ends, as always;
- each chat's workspace on that replica is released; its next turn is
  admitted on a live machine and restores the workspace from its
  `sessions/<id>` branch. Chats on workers and on members' machines keep
  their workspaces: any replica runs their turns;
- the lost machine disappears from `GET /_work/operator/machines`.

Server agent sessions checkpoint to isolated `sessions/<id>` branches in the
shared origin after every settled turn. Relocation reconstructs the workspace
and model history; it does not migrate a live process or publish session edits
to project `main`. Failed checkpoint persistence is a failed turn requiring
recovery. Work not checkpointed before a machine is lost, and a chat's
background processes, are gone with it and never automatically replayed.
Members' program drafts live in the project origin (ADR 0191), never on a
replica, so losing one loses no draft.

## A member's This machine

Declare a project Environment with `device: "member"`, workload `agent`,
and appropriate role grants. The desktop's **Connect This machine** action starts
an authenticated SDK runner using its local sandbox provider. It receives no
Postgres credentials. Discovery and every operation retain the member's current
project and Environment permissions. Closing the desktop or losing authorization
stops the runner. A new connection lifetime cannot revive an old allocation.
The runner renews its own lease through any replica, so its chats belong to no
replica: any replica runs their turns, and they continue when the replica
that admitted them stops (ADR 0192). While the runner is away, its chats' turns stay
queued instead of failing. When it connects again, a new connection cannot
revive the old workspace (see above): each chat is admitted on the new
connection and its workspace rebuilt from its `sessions/<id>` branch.

Stock local execution uses the controller topology: the host model loop and
connection broker stay on the server; sandbox commands and files run on the
member's machine. Native local CLI execution is not advertised by the stock host.
Do not call a controller sandbox a locally running model or promise offline use.

## Connections and verification

`WORK_GATEWAY_CONFIG` declares the connections the server brokers (MCP
endpoints, HTTP APIs, databases, Git hosts, model APIs); guards that review
them are code in a custom server. See
[secrets and the gateway](secrets-and-gateway.md). This is host endpoint
configuration, not workflow logic or a second role model.
Organization administrators connect the named service connections once;
projects commit which Environment binds which name in `.work/project.json`,
and roles grant the aliases (ADR 0172). Members authorize their own accounts
and explicitly review each workflow before enabling it. Service credentials
stay on the control plane: workers reach them only through the gateway, and
Postgres sessions are pooled on the control plane, not on workers.

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
`.work/agents/developer.json` definition:

```json
{
  "environment": {
    "allowed": ["development"],
    "preferred": ["development"],
    "requirements": {
      "isolation": "sandbox",
      "resources": {
        "cpuMillis": 2000,
        "memoryMb": 4096,
        "commandTimeoutSeconds": 1800
      }
    }
  }
}
```

Microsandbox enforces whole-core CPU limits (multiples of 1000 millicores) and
memory in MiB. Disk and GPU limits are currently rejected by the stock providers.
Native host CLI execution does not enforce these sandbox limits; use controller
agents for this setup. The stock controller and connection broker remain outside
the VM. `resources.commandTimeoutSeconds` bounds one foreground command, an
agent's shell command included (ten minutes when unset). Longer work runs as a
background command: the built-in agent starts it with `run_background_command`,
follows it with `read_background_output`, and stops it with
`stop_background_command`. Background processes run inside the workspace on
the worker and end when the chat closes or the workspace is destroyed
(ADR 0174). The local-process backend has a workspace-slot budget but rejects
CPU/memory budgets; it is still for trusted single-tenant work only.

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

## Images, containers, and egress

An Environment chooses its sandbox (ADR 0176) in `.work/project.json`:

```json
{
  "environments": {
    "review": {
      "workloads": ["agent"],
      "image": ".work/images/review.Dockerfile",
      "requirements": { "containers": true },
      "network": { "egress": "allowlist", "allow": ["github.com", "*.npmjs.org"] },
      "approvals": { "waitMinutes": 60 }
    }
  }
}
```

- `image` is an OCI reference (`node:22`) or a project Dockerfile. Only
  microsandbox machines boot images. A Dockerfile needs a machine with a
  builder: set `WORK_IMAGE_BUILDER=docker` (or `podman`) and install that CLI
  and its daemon on the machine. The build context is the Dockerfile alone;
  each machine builds a digest once and keeps it cached. Build steps (`RUN`)
  use the builder's network, not the Environment's `network.egress`, so
  review a Dockerfile's downloads like the rest of the program, or give the
  builder's daemon a restricted default network or proxy.
- `requirements.containers` places the work where the sandbox gets its own
  container runtime. On microsandbox, Docker runs inside the VM (on by
  default; `WORK_SANDBOX_CONTAINERS=0` turns it off) on a private disk, and
  the image must ship `dockerd`: use `docker:dind` or a Dockerfile `FROM` it.
  A trusted local-process machine offers containers with
  `WORK_DOCKER_SOCKET=/var/run/docker.sock`: each sandbox gets its own
  endpoint as `DOCKER_HOST` that serves only the API routes and settings the
  Docker CLI and Compose use. The sandbox sees only what it started, cannot
  run privileged containers, add capabilities or devices, share host
  namespaces, use other volume drivers, or mount host paths outside its
  workspace, and everything it started is removed with it. Images are a
  cache shared by the machine. Builds use the classic builder
  (`DOCKER_BUILDKIT=0` is set for the sandbox), so `docker buildx` and
  BuildKit-only Dockerfile features are not available there. Where Compose
  is a per-user plugin (Docker Desktop), also set `WORK_DOCKER_CLI_PLUGINS`
  to that plugin directory.
- `network.egress` is `open` (default), `gateway` (only this server's public
  host and port, from `WORK_PUBLIC_URL`, and DNS), or `allowlist`. Only microsandbox
  enforces it, containers inside the VM included. A restricted image must
  already contain git and bash, since the setup step cannot install them.
  Local-process refuses such Environments unless the operator sets
  `WORK_UNENFORCED_EGRESS=accept`, which runs them with open egress.

Machines advertise `images`, `images.build`, `containers`, and
`network.policy`, `sign-ins` and one `sign-in:<harness>:<member>` per
member signed in on them, and a local-process machine `harness.claude-code` and
`harness.codex` when those CLIs are on its `PATH`;
`GET /_work/operator/machines` shows them. An Environment
no machine satisfies reports which capability is missing. VM budgets include
nested containers; the Docker disk has its own size, and local-process
containers are not budgeted.

### Setup and volumes

Images hold a team's toolchain; setup and volumes hold what the project
installs with it, so the second workspace on a machine starts from warm
caches (ADR 0207):

```json
{
  "environments": {
    "dev": {
      "workloads": ["agent"],
      "image": ".work/images/dev.Dockerfile",
      "requirements": { "containers": true },
      "setup": "corepack enable && pnpm install --frozen-lockfile",
      "setupTimeoutMinutes": 45,
      "volumes": {
        "pnpm": "~/.local/share/pnpm/store",
        "docker": { "path": "/var/lib/docker", "exclusive": true, "sizeMb": 20480 }
      }
    }
  }
}
```

- `setup` is a shell command run in the project folder of every new
  workspace before its first turn, once the chat's secrets and the member's
  personal files are in place, and again when the command changes. A
  workspace rebuilt after idle release runs it again. Its first failing
  command stops it. Output is appended to `.work-session/setup.log` beside
  the project, and the chat shows that the workspace is being set up. A
  failure, or a run longer than `setupTimeoutMinutes` (30 by default), is
  told to the agent with the end of the log; the turn goes on, and setup
  runs again before the next turn. A member may add their own `setup` in
  `.work/personal/environment.json`: it runs after the Environment's, only
  in their own chats in Environments with `"personalCredentials": true`,
  and only for turns they wrote.
- `volumes` name directories kept on the machine for each owner (a member,
  or the project for its own chats and runs) and project: the owner's next
  sandbox on that machine mounts the same directory, and nobody else's does.
  A path is absolute or starts with `~/`, the sandbox user's home. Point
  package stores and caches at them, such as pnpm's store above.
- An `exclusive` volume, such as a Docker data root or a database's data
  directory, is mounted into one sandbox at a time. Placement records which
  sandbox holds it, in Postgres, so every replica agrees; a sandbox that
  starts while another of the same owner's holds it gets an empty temporary
  one that goes away with it, and its agent is told. The hold ends when the
  holding sandbox is destroyed. `sizeMb` sizes the disk a backend gives an
  exclusive volume when it needs one.
- Volumes stay on their machine: moving to another machine starts cold.
  They hold whatever the owner's code writes there, credentials included.
  Machines advertise `volumes` when their backend keeps them; local-process
  keeps only paths under `~`. A machine forgets volumes nobody used for 30
  days (`WORK_VOLUME_RETENTION_DAYS`) and a member's volumes when a pooled
  machine is reset.

## Members' own sign-ins and files

An Environment with `"personalCredentials": true` lets a member's chats run
Claude Code or Codex on the member's own sign-in, made on a machine with
`work worker sign-in <claude-code|codex> --member <id>` in a terminal there
(ADR 0199, [harnesses](harnesses.md#members-own-sign-ins)), and lets their
listed files reach their own chats. The sign-in never leaves that machine:
the worker reports only `sign-in:<harness>:<member>` in its offer, and
placement takes only a machine reporting the chat owner's. Only placements
that isolate the member qualify: microsandbox, a worker whose access names
only that person, or the member's device. A local-process machine that
serves several people (a `trusted` worker, or the control plane itself)
refuses them unless its operator sets `WORK_PERSONAL_CREDENTIALS=accept` on
that machine (the worker's own environment, like `WORK_UNENFORCED_EGRESS`),
which advertises `credentials.personal`. Give such Environments egress to
`api.anthropic.com`, `chatgpt.com`, and `api.openai.com` when they restrict
it, and the CLIs on the path or in the image. A company that wants these
harnesses for everyone binds a model connection instead
([harnesses](harnesses.md)).

## Unattended agents

A committed agent's `sandboxing` decides what leaves its sandbox:
`contained` keeps every change in the sandbox, pushes nothing, and calls only
read connection actions, `propose` may propose but not deploy or publish,
`publish` may do what its roles allow. The Work server defaults project
agents to `propose`. Its `toolPolicies` narrow tools on the server as on the
desktop. A Claude Code or Codex agent's own permission mode is separate:
`harnessPermissions` (see [harnesses](harnesses.md)).

An approval in a project chat goes to the approvers the automation named when
it delivered (`deliver({ key, audience: "project", approvers: { members: [...],
roles: ["reviewer"] } })`). They get a notification, the chat appears for
them, and they may answer its approval card without otherwise holding the chat.
It waits `approvals.waitMinutes` (30 by default) and then is denied with a
reason. A chat with no approvers refuses at once.

## Docker, development services, and private HTTP

Catamorphic does not require a team service manifest or parse Compose files.
Agents run `docker compose up`, package scripts, or other ordinary commands
in an Environment that asks for `containers` (above). Advertising a custom
`docker` capability does not install Docker or grant access to a socket, and
no sandbox receives the host's Docker socket directly.
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
3. Stop each control-plane replica with SIGTERM: its work moves to the
   replicas still running, or waits for the next one to start. Then start the
   new version; boot applies coordinated migrations. A replica needs no data
   volume or identity carried over.
4. For a worker or a single server, disable the machine through the operator
   API before replacing its process. Disabling fences claims and lease
   renewal; it is not a graceful drain of running work. Never use it as
   evidence that an external action was undone. Update the service/image while
   preserving that machine's own data volume and identity. Re-enable the
   machine through the operator API and verify heartbeat, capabilities, and
   capacity before use.
5. Test sign-in, a permitted session, private HTTP access, and checkpoint
   persistence. Explicitly recover or relocate interrupted sessions. A service
   restart does not move a live process or promise automatic replay.

A package downgrade cannot undo forward-only database migrations. Follow the
release's recovery plan, which may require restoring the database and matching
application version. Hosts with unattended rollout requirements can automate
these existing controls in their own deployment system.
