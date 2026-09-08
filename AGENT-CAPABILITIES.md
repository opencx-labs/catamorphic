# Agent context and capabilities

Catamorphic gives each agent fresh host session facts and a small discovery
interface. The project authority, ordinary identity, Environments, WorkerNodes,
and Allocations remain the source of execution and permission decisions. See
[ADR 0103](docs/decisions/0103-agent-context-and-deferred-capabilities.md).

## Default context

Before each turn, core supplies the current user ID, project ID/name, session,
Allocation, Environment, runtime host, execution binding/WorkerNode, working
directory, isolation, declared capabilities, and workspace lifetime. A host can
supply a display name and time zone through `agentCapabilities.currentUser`.
Absent profile information stays absent; core does not invent a user directory.

The agent loop's host and its command target are separate fields. For **This
machine**, the model loop can remain on a server while sandbox commands execute
on the member's device. `localhost` in a shell command addresses the command
target. A declared Docker capability does not prove Docker Engine is installed,
healthy, or authorized. Harness sandbox settings remain provider configuration;
core does not guess whether they are enabled. The turn prompt identifies its
actual loop host and working directory. A standalone `context.read` can run on a
different API instance, so those fields are `null` instead of guessing the loop's
location from the API server.

Facts are delivered separately from user prose and refreshed on each turn,
including resumed sessions and retries. Claude uses its preset's appended
instructions, AI SDK uses turn instructions, and Codex uses developer
instructions. Descriptive names are data. No credentials, email addresses,
permission arrays, lease tokens, or other users are injected automatically.

## Discover and invoke

All bundled harness adapters accept a session-scoped `AgentCapabilityGateway`.
Only `discover_capabilities` and `invoke_capability` are added to the initial tool
set. Discovery returns matching permitted names, descriptions, effects, and input
and output schemas, with a cursor and at most 20 results. Load the relevant schema
before invoking an operation. Discovery does not invoke that operation.

Default capabilities:

| Name | Result |
| --- | --- |
| `context.read` | Fresh user/project/session and execution facts |
| `environments.list` | Role-permitted project Environments and availability |
| `assignments.current` | The current pinned Allocation and resource reservation |
| `people.search` | Stock-host project member IDs and names, only for membership managers |

The stock directory searches member IDs and pages results. Hosts can replace it
with their own permission-filtered directory, including name search. There is no
tenant-wide directory or fleet inventory inferred from historical Allocations.
Hosts can register inventory, service exposure, or administration capabilities
through the same registry. Native shell/file tools remain supplied by the harness.

A host can use returned descriptors for its harness's native deferred-loading
mechanism. The portable two-tool adapter works without that feature. MCP alone
does not determine which schemas a harness puts into its prompt.

## Host registration

```ts
import { defineAgentCapability } from "@catamorphic/core";
import { z } from "zod";

const listAssignments = defineAgentCapability({
  name: "assignments.search",
  description: "Search assignments visible to the current project member.",
  effect: "read",
  inputSchema: z.object({
    query: z.string().max(200).default(""),
    cursor: z.string().optional(),
    limit: z.number().int().min(1).max(20).default(10),
  }).strict(),
  outputSchema: z.object({
    items: z.array(z.object({ id: z.string(), label: z.string() })),
    nextCursor: z.string().optional(),
  }),
  authorize: (context) => hostPolicy.canInspectAssignments(context),
  execute: (context, input) => hostAssignments.searchVisible({
    identity: context.identity,
    projectId: context.projectId,
    ...input,
  }),
});
```

`hostPolicy` and `hostAssignments` are host dependencies. Pass capabilities in
`createCatamorphic({ ..., agentCapabilities: { capabilities: [listAssignments] } })`.
The stock server accepts the same option. Duplicate registered names fail at boot;
custom stock `people.search` explicitly replaces the stock directory default.
Schemas must be JSON-schema representable. Results must be JSON and at most 1 MiB;
use bounded queries and resource references for larger output.

`authorize` runs for discovery and invocation. Executors must also enforce access
to the particular records requested; accepting an ID never grants access to it.
Use the host's existing `resolveMemberIdentity` hook to refresh revocable member
policy before discovery and invocation, including after approval. Host-issued
root identities do not pass through membership resolution; hosts remain
responsible for their authority. The stock server resolves memberships live. Identity refresh cannot change the tenant or acting user, or expand the grants
carried by the original caller. A fresh turn can bind a newly authorized identity.

`beforeInvoke` receives the validated input, current identity, session,
Allocation, effect, operation ID, cancellation signal, and progress callback.
Hosts can reject an operation or await their existing approval mechanism there.
After it returns, core checks identity, Allocation, and authorization again.
Use the existing durable request/approval system when approval must survive a
process restart; do not make tool prose or a cached schema the approval record.

`onEvent` receives started/completed/failed/progress activity without tool inputs
or results. Core also emits `agent.capability.invoke` OpenTelemetry spans.
Observer failures cannot change an already executed operation's result. Persist
activity through the host's audit sink when durable audit is required.

Writes receive a stable `requestId`. Their executor must use it with the owning
service's durable idempotency mechanism. The gateway and HTTP client do not retry
writes automatically or promise exactly-once external side effects. Cancellation
is cooperative: executors must observe the signal, and cancelling a request is
not proof that an external write did not happen.

## SDK and transport

```ts
const gateway = catamorphic
  .forTenant({ tenantId })
  .forUser(memberIdentity)
  .capabilities({ projectId, sessionId });

const page = await gateway.discover({ query: "assignments" });
```

For an executing agent, pass `allocationId` to `.capabilities(...)` to pin its
gateway. Direct core hosts use
`core.agentCapabilities.forSession({ identity, projectId, sessionId, allocationId })`.
Core does this for bundled session turns. Old gateways must fail after an explicit
move or release; never silently resolve a replacement Allocation.

HTTP routes are prefix-relative:

- `POST /projects/:projectId/agent/sessions/:sessionId/capabilities/discover`
- `POST /projects/:projectId/agent/sessions/:sessionId/capabilities/invoke`

Both use the host's ordinary bearer authentication. A remote host can construct
`HttpAgentCapabilityGateway` from `@catamorphic/sandbox` with a session-specific
base URL, the pinned `allocationId`, and a `headers()` function that refreshes
credentials per request. `x-catamorphic-allocation-id` narrows the request to that
Allocation; it is not authentication. Bind remote credentials to the intended
session/Allocation at the host's auth layer. Never give a developer machine a
broader control-plane credential. No callbacks are serialized across machines.

The project MCP endpoint exposes the same two tools when supplied a `sessionId`
query parameter. Include `allocationId` for an executing agent. The Codex adapter
uses a temporary authenticated loopback MCP bridge for its subprocess and closes
it after the turn. Native MCP and in-process calls reach the same gateway.

## Setup and troubleshooting

Check the installed source and host configuration before suggesting operations.
A capability missing from discovery can mean it is unregistered or unauthorized;
neither case should reveal hidden records. A revoked invocation requires checking
current host policy, not reusing an earlier tool list. An Allocation mismatch
requires stopping the stale executor and following the ordinary explicit move
flow. Do not remove the fence to make it work.

Verify current-user context, cross-user/cross-project denial, directory field
filtering, permission changes after discovery and approval, cancellation,
Allocation changes, output validation, and both HTTP and subprocess MCP. Keep
infrastructure setup in the host's existing provisioning/access/update workflow;
see the [cluster setup reference](skills/setup-catamorphic-server/references/cluster-deployment.md).
