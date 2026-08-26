# Agent Runtimes, Capabilities, and Personal Artifacts Design

## Status

Approved on 2026-08-24.

## Purpose

Give every coding-agent harness the same complete host surface while retaining
the native strengths of Claude Code, Codex, and future providers. Catamorphic
must be able to observe and control approvals, questions, tools, processes,
tasks, watches, timers, schedules, and wakeups so its hosts can render useful
UI and execute the same work locally or on remote machinery.

The same architecture must support personal artifacts inside a project without
making private files remotely executable. A committed project workflow may run
remotely for a member using that member's explicitly connected accounts and
durable consent.

This is a greenfield replacement. Old contracts, bridges, topology labels, and
service-only unattended assumptions are removed in the phase that replaces
them. There is no compatibility layer or dual-write period.

## Product invariants

1. Project code remains the source of truth. Workflow logic is TypeScript, not
   a tool payload, JSON DSL, or database-authored graph.
2. A durable workflow Run always executes an exact committed deployment.
3. Private personal artifacts never sync to, deploy to, or execute on a remote
   Environment.
4. A remote workflow is visible and reviewable project code, but it may run as
   an explicitly consenting member using that member's connected accounts.
5. Provider credentials remain in the control plane. Agent processes and
   workflow sandboxes receive narrow capability grants, never upstream
   credentials.
6. The host owns policy, durable state, audit, and UI. Harnesses retain their
   native prompts, project conventions, models, and provider-specific tools.
7. Sessions outlive turns. Processes, tasks, watches, questions, and approvals
   are not inferred from a single `sendMessage` iterator.
8. Terminals are views of host-owned processes, not the process authority.

## 1. Long-lived agent runtime contract

Replace `CodingAgentProvider` and its turn-shaped `sendMessage()` iterator with
an `AgentRuntimeProvider`. A provider exposes its capabilities, starts one
long-lived runtime session for an Allocation, accepts turn commands, and emits
an independently subscribable ordered event stream.

The public shape is conceptually:

```ts
interface AgentRuntimeProvider {
  describe(): Promise<AgentRuntimeDescriptor>;
  startSession(input: StartAgentRuntimeSession): Promise<AgentRuntimeSession>;
  resumeSession(input: ResumeAgentRuntimeSession): Promise<AgentRuntimeSession>;
  stopSession(input: StopAgentRuntimeSession): Promise<void>;
  startTurn(input: StartAgentTurn): Promise<AgentTurnHandle>;
  retryTurn(input: RetryAgentTurn): Promise<AgentTurnHandle>;
  interruptTurn(input: InterruptAgentTurn): Promise<void>;
  respond(input: RespondToAgentRequest): Promise<void>;
  subscribe(input: SubscribeToAgentEvents): AsyncIterable<AgentRuntimeEvent>;
  listTasks(input: ListAgentTasks): Promise<AgentTask[]>;
  controlTask(input: ControlAgentTask): Promise<void>;
}
```

The concrete TypeScript API follows repository conventions: keyed object
parameters, discriminated unions, no `any`, and host-injected dependencies.
`resumeSession` is supported only when a provider advertises resumability;
otherwise core re-anchors from persisted transcript and working state.

Every event has a stable event id, monotonic session sequence, timestamp,
session id, optional turn id, provider payload reference, and normalized
payload. Core deduplicates by event id and persists the normalized event before
broadcasting it to clients. Subscribers resume from a cursor. Delivery is at
least once; reducers are idempotent.

Normalized event families are:

- session and turn lifecycle;
- assistant/user/system message deltas and completed messages;
- tool requested, started, progressed, completed, failed, or cancelled;
- approval, question, and MCP elicitation requests and resolutions;
- plan replacement and plan-item state;
- provider task and subagent lifecycle;
- host process and watch lifecycle;
- file and workspace changes;
- usage, cost, model, and context-window snapshots;
- provider diagnostics and recoverable/fatal errors.

Requests are first-class records, not prose. `approval`, `question`, and
`elicitation` share ids, expiry, status, origin, and response semantics while
retaining typed payloads. They may be answered from desktop, PWA, or another
host client. No active window means the request stays pending until its expiry
or an explicit policy decision; it is not silently approved.

The runtime descriptor reports supported models, efforts, built-in tools,
dynamic-tool support, MCP generations, resumability, approvals, questions,
elicitation, plans, tasks, subagents, usage, and event fidelity. The UI uses
this inventory to describe real limitations rather than provider-name
conditionals.

## 2. Faithful Claude Code and Codex adapters

The Claude adapter consumes the full Agent SDK stream. It keeps the
`claude_code` preset and all configured settings sources. The current static
allowed-tool list is removed. SDK permission callbacks, hooks, system events,
results, plans, questions, tasks, subagents, background activity, and usage are
mapped into the normalized runtime contract. Policy is decided dynamically at
the moment of use.

The Codex adapter moves from the high-level one-turn SDK wrapper to a
long-lived Codex app-server connection. It handles server requests for command
and file approvals, user input, and MCP elicitation; consumes item, plan,
subagent, diff, usage, and lifecycle notifications; and supplies dynamic tools
through the capability gateway. Provider thread identity belongs to the
runtime session and survives turns.

Provider-native file and shell tools remain available when the selected
Environment admits them. Adapters normalize their events and associate any
spawned process with the Allocation. Canonical host lifecycle capabilities
such as schedules and watches are supplied by Catamorphic rather than a
provider-private state file.

All adapters, including the built-in AI SDK agent, pass one shared conformance
suite. The suite tests event ordering and replay, interruption, request/answer
round trips, policy denial, progress, cancellation, task control, usage, and
capability reporting. Unsupported features must be declared, not emulated with
heuristics that appear authoritative.

## 3. Unified capability gateway

Replace `ExtraTool`, desktop workspace-tool wiring, bespoke in-process Claude
MCP servers, and Codex-only loopback bridges with one `CapabilityRegistry` and
`CapabilityGateway`.

A capability definition includes:

- stable namespace and name;
- title, description, and input/output JSON Schemas;
- MCP-compatible annotations such as read-only, destructive, idempotent, and
  open-world hints;
- required identity, project, Environment, connection, and role scopes;
- interaction support: progress, cancellation, deadline, and elicitation;
- availability and execution-placement constraints.

An invocation includes the authenticated identity, tenant, project,
Allocation, session and turn when present, workflow enablement when present,
connection grant scope, request id, deadline, cancellation signal, and trace
context. Results use MCP-style structured content plus an optional typed
structured result. Secrets and raw credential material are never valid result
content.

Invocation always passes through the same pipeline:

1. resolve definition and current availability;
2. validate input;
3. revalidate identity, Allocation, role, enablement, and connection scope;
4. apply the strictest policy layer and, when required, create an approval;
5. invoke locally or route to the Allocation's runner;
6. stream progress and structured events;
7. sanitize and validate output;
8. persist audit and telemetry.

Adapters expose the same registry in three ways: direct in-process invocation
for the built-in agent, MCP over authenticated HTTP or stdio, and provider
dynamic tools for Codex app-server. These are transports over one registry,
not separately implemented tool sets. MCP clients outside agent runtimes use
the same gateway.

Catamorphic reserves canonical namespaces for project operations,
connections, processes, watches, schedules, wakeups, documents, skills, and
workflow calls. Hosts and plugins may register more definitions. A collision
is a boot error unless an embedder explicitly replaces a capability by id.

This gateway is the interception seam for UI. A host can render approvals,
progress, process cards, schedules, artifacts, or custom capability results
without teaching each harness a proprietary protocol.

## 4. Allocation runners and remote execution

ADR 0064's four topology labels are replaced by two agent-loop placements:

- `control_plane`: the harness loop runs with the Catamorphic control plane;
- `environment`: the harness loop runs through the selected Environment's
  runner.

Containment, native subprocesses, VM boundaries, and provider-hosted runtimes
are runner implementation details and advertised capabilities, not public
topologies. An Allocation selects exactly one Environment and runner before a
session or Run starts. The runner owns workspace, process, and capability
routing for that Allocation.

The runner contract covers:

- materialize or attach to a workspace at an exact project revision;
- start, resume, inspect, and release an agent runtime;
- execute host-routed capabilities when placement requires it;
- start and control processes and PTYs;
- stream runner events with cursors;
- report health, leases, resource usage, and supported capabilities.

The first implementations are a local runner used by desktop and stock server,
and a remote runner transport used by managed Environment providers. Existing
Cloudflare, Microsandbox, Daytona, and local-process packages adapt behind the
runner boundary. Unsupported topology branches are deleted.

The control plane remains canonical for identity, transcript, Runs,
enablements, schedules, policy, and audit. A remote runner may reconnect and
replay events, but it never becomes the credential or authorization authority.

## 5. Workflow enablements and member credentials

A committed workflow definition is inert code until an authorized principal
enables a trigger or schedule. Introduce a first-class
`WorkflowEnablement`, separate from the workflow definition and deployment.

An enablement binds:

- tenant, project, workflow, and exact deployed commit;
- owner mode: `member` or `service`;
- exact member or service principal;
- exact Environment;
- exact connection ids for every required alias;
- narrowed capabilities and a durable-consent digest;
- trigger or schedule references;
- `active`, `suspended`, or `disabled` state plus an independent
  `updateAvailable` flag;
- suspension reason, timestamps, and audit identity.

A member may connect accounts on a remote Catamorphic server and enable a
reviewed project workflow to run there as that member. Several members may
enable the same workflow independently with different accounts and schedules.
Project and tenant service enablements use the same model with administrative
authority instead of member consent.

At enablement, the server validates current membership, role grants,
Environment access, workflow requirements, exact connection ownership,
provider scopes, narrowed capabilities, and durable consent. Every dispatch
and every broker call revalidates the relevant live facts. Removing the
member, revoking a role or connection, requiring reauthentication, or changing
an Environment ceiling suspends that enablement. It never falls back to
another member or service identity.

Interactive member Runs may resolve live member connections without creating
an enablement. Any unattended dispatch requires an active enablement.

Enablements pin their deployed revision. Deploying a new revision marks old
enablements `update_available`; it does not silently change executed code.
The owner or an authorized administrator explicitly updates the enablement,
which reruns requirement checks and durable consent. This is deliberately
conservative for the first version and can later gain a policy-controlled
safe-update mode.

Existing trigger bindings reference an enablement instead of storing their own
credential snapshot. ADR 0066's service-only unattended restriction is
removed.

## 6. Processes, provider tasks, and watches

Catamorphic owns a normalized process service for each Allocation:

- `process.start`, `process.list`, `process.get`, `process.read`,
  `process.write`, `process.stop`, and `process.attach`;
- explicit process kind, command summary, cwd, owner, status, exit result,
  start/end times, and bounded output cursor;
- PTY and non-PTY modes;
- cancellation and allocation-release behavior.

Terminal tabs attach to a process id. Closing a terminal view does not
implicitly kill its process. Stopping or releasing the owning Allocation does,
subject to an explicit detached-process policy.

Provider-native foreground shell tools may remain native and emit normalized
tool events. Persistent or interactive background work must use the process
service. An adapter may expose a provider-owned process through the same
contract only when the provider supplies authoritative read, write, stop, and
status operations. Otherwise the adapter reports an observed tool completion,
not a guessed live process. Agent guidance directs persistent commands to
`process.start`; command-text daemon heuristics are removed.

Provider tasks and subagents remain distinct from OS processes, but both map
to a common UI-facing activity model. Providers expose task operations when
supported; the host never invents control over a provider task it can only
observe.

A Watch is a host-owned condition that emits state changes and may wake an
agent task or workflow control path. Initial watch kinds are:

- process output and exit;
- file or directory change;
- port readiness;
- HTTP condition;
- git working-tree or ref change;
- CodeHost pull-request or CI state;
- host/plugin-defined external conditions.

Watches have owner, Allocation or enablement scope, target, condition,
poll/event strategy, expiry, state, last observation, and wake action. Remote
watches execute through a leased Environment runner or control-plane provider.
They survive individual agent turns. Reconnect resumes from persisted state
and event cursors.

## 7. Personal artifacts

Each project may contain a profile-scoped local tree:

```text
.catamorphic/personal/<profile-id>/
  workflows/
  skills/
  documents/
  apps/
  agents/
```

The desktop adds `.catamorphic/personal/` to the repository's local git exclude
file. It does not modify the project's tracked `.gitignore`. The tree is plain
files in the project working copy: no nested repository, snapshot store,
database copy, synchronization, or promotion record.

Local discovery merges personal artifacts into the current profile's project
view and labels their provenance. Other profiles and remote servers do not
discover them. Personal workflows may be invoked directly by the local
development harness. Such an invocation is best effort, executes current
files, requires the desktop to remain available, and is not a durable
Workflow Run. Editing or restarting can invalidate it.

There is no promotion API, button that mutates artifacts, or special merge
algorithm. “Share with project” opens a normal coding-agent task. The agent
moves files into the canonical project locations, removes personal paths and
private assumptions, updates imports, dependencies, roles, connection
requirements, triggers, and documentation, and runs the project's checks. The
result follows ordinary checkpoint, diff, review, proposal, and pull-request
flows. The UI may offer an “Ask agent to share with project” prompt shortcut.

Only the moved, committed, reviewed project artifact can deploy or run in a
remote Environment.

## 8. Schedules, timers, and wakeups

Expose canonical capabilities:

- `schedule.create`, `schedule.list`, `schedule.get`, `schedule.update`,
  `schedule.delete`, and `schedule.run_now`;
- `wake.create`, `wake.list`, and `wake.cancel`;
- `watch.create`, `watch.list`, `watch.get`, and `watch.stop`.

A durable Schedule belongs to a committed workflow enablement. It stores a
timezone-aware calendar or interval expression, next occurrence, misfire
policy, overlap policy, status, and audit metadata in Postgres. The existing
Postgres queue and `SKIP LOCKED` claim model dispatches due occurrences. A
remote member-owned schedule runs through that member's active enablement and
connections. A service schedule uses its service enablement.

A Wake is a one-shot durable resume signal for a session, workflow pause, or
host activity. It is not a miniature workflow scheduler. Expired or cancelled
wakes are terminal and auditable.

A personal local schedule targets a personal workflow path and lives in the
desktop profile store. It is explicitly labelled “Runs when this desktop is
online,” uses current local files, and is best effort. It cannot select a
remote Environment or create a canonical Run. Moving the workflow into the
project does not migrate the schedule; the agent creates a reviewed project
enablement and durable schedule as a separate change.

Provider-private schedule files, including Claude-local schedule state, are
not Catamorphic product state. Adapters expose the canonical schedule
capabilities and suppress or redirect provider-native schedule creation when
the SDK allows interception. If it cannot be intercepted safely, the runtime
descriptor and UI state that limitation explicitly.

## 9. Reference-host UI

The desktop and PWA consume normalized records rather than provider-specific
messages. The first vertical slices are:

1. approval, question, and elicitation cards with pending-state recovery;
2. tool progress and structured result cards;
3. process chips and attachable terminal tabs;
4. provider task, subagent, and Watch status;
5. schedules showing owner, target revision, Environment, next occurrence,
   location, and suspension reason;
6. personal versus project provenance on artifacts;
7. “Enable for me,” exact connection selection, durable consent, update
   available, reauthentication, and suspension flows.

Every surface is driven by framework hooks and schemas so embedders can replace
the visual treatment. Host doctrine and labels remain injectable.

## 10. T3 Code lessons retained

T3 Code demonstrates several useful boundaries: a long-lived provider runtime
behind a server process, Codex app-server rather than only the high-level SDK,
scoped MCP gateways, a UI broker for tool interactions, explicit provider
capabilities, and client reconnection around a stable runtime identity.
Catamorphic adopts those separations.

Catamorphic does not make one runtime server the owner of project identity,
workflow state, credentials, or schedules. Those remain in the embeddable
control plane and its Environment/Allocation contracts. It also does not treat
background-command observation as a durable scheduler.

## 11. Failure, security, and observability

- Provider or runner disconnects produce a recoverable runtime state. Core
  reconnects from event cursors or re-anchors when the provider cannot resume.
- Pending approvals and questions survive client disconnects and expire
  according to policy.
- Process survival is guaranteed only while its runner lease is healthy.
  Durable workflows recover from persisted boundaries, not by assuming an OS
  process survived.
- Schedule claims use lease fencing and idempotent occurrence keys. Misfires
  follow the schedule's explicit policy.
- All gateway, runner, process, Watch, request, enablement, and schedule hot
  paths emit `@catamorphic/otel` spans and sanitized audit events.
- Raw tool arguments and results are not logged by default. Credential values
  are never accepted as telemetry attributes or event payloads.
- Capability grants are short-lived, hashed at rest, Allocation-bound, and
  revoked when their Allocation or enablement is no longer authorized.

## 12. Breaking delivery sequence

Each phase removes the contract it replaces. There is no legacy adapter.

1. **Agent runtime foundation:** introduce descriptors, long-lived sessions,
   commands, normalized events, requests, persisted cursors, and the provider
   conformance suite; migrate core and clients; delete `CodingAgentProvider`.
2. **Provider fidelity:** rebuild Claude Code and Codex on the new contract,
   including Codex app-server; migrate AI SDK; remove static tool allowlists
   and background-process heuristics presented as control.
3. **Capability gateway:** add the registry, policy pipeline, structured
   results, progress, cancellation, audit, and in-process/MCP/dynamic-tool
   adapters; delete `ExtraTool` and bespoke workspace bridges.
4. **Runners:** introduce local and remote runner transports, migrate
   Environment bindings and Allocations, replace four topology labels with two
   placements, and remove unsupported branches.
5. **Workflow enablements:** add schema and services for member/service
   enablements, exact connections, consent, suspension, and pinned revisions;
   migrate trigger bindings and broker checks.
6. **Processes and watches:** add Allocation-owned processes, PTY attachment,
   provider task normalization, Watch providers, leases, and UI activity.
7. **Personal artifacts:** add local exclusion, discovery, direct local
   invocation, provenance UI, and the agent prompt for sharing with project.
8. **Schedules and wakeups:** add durable Postgres schedules/wakes, local
   best-effort schedules, gateway tools, dispatch, and ownership UI.
9. **Complete UI slices and remove residue:** finish desktop/PWA surfaces,
   delete provider-name conditionals and old schedule/background paths, update
   public embedding contracts and documentation.

After every phase, run repository lint, typecheck, build, tests, migrations and
code generation where applicable, API generation where applicable, desktop
e2e, and browser verification for UI changes.

## 13. Acceptance criteria

- The same host capability can be invoked by AI SDK, Claude Code, Codex, an
  MCP client, and a remote Environment without separate business logic.
- A user can answer a Codex approval or Claude question from desktop or PWA
  after the originating turn stream has yielded.
- A process started by an agent remains visible and attachable after the turn;
  its lifecycle is authoritative rather than command-text inference.
- An agent can create a Watch or Schedule and the UI immediately renders the
  normalized object and subsequent state changes.
- A personal workflow cannot be selected for remote execution by any API.
- A committed workflow can be enabled remotely by two members with different
  exact connections, and revoking one member suspends only that enablement.
- Deploying new workflow code never silently changes an existing enablement's
  revision.
- No provider credential appears in a sandbox, runner event, capability
  result, Allocation, project file, log, trace, or API response.
- All provider adapters pass the shared conformance suite and declare any
  unsupported feature in their runtime descriptor.

## 14. Alternatives rejected

- **Keep wrapping each harness ad hoc:** this preserves duplicated policy,
  incomplete events, and transport-specific tools.
- **Use MCP as the internal abstraction:** MCP is an important transport but
  does not own session lifecycle, provider tasks, runner placement, or durable
  policy state.
- **Let harness-native schedulers be canonical:** their state is local to one
  provider and cannot provide consistent remote ownership, audit, or UI.
- **Snapshot private workflows for remote execution:** a snapshot is still
  private, unreviewed code running remotely and creates another version model.
- **Store personal artifacts in a nested git repository:** it complicates
  discovery, worktrees, backup, and promotion without helping the local-only
  requirement.
- **Require service identities for all unattended work:** this prevents the
  explicitly desired member-owned automation model.
- **Auto-upgrade enablements to the latest deployment:** reviewed code can
  still change authority requirements or behavior; explicit update is safer
  and simpler initially.
