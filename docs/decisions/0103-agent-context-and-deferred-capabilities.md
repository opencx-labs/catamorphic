# 0103: Agent context and deferred capabilities

- **Status:** Accepted
- **Date:** 2026-09-08
- **Builds on:** 0067, 0098, 0099, 0100

## Context

Agents need to understand their execution target and discover permitted host
operations without carrying an infrastructure or user directory in every prompt.
The agent loop and its command target may reside on different machines.

## Decision

Inject compact factual context separately from user messages, refreshed every
turn. Identify the current user, project, session, Allocation, runtime host, and
workspace. Optional profile fields come from the host. Descriptive fields are
data, never instructions or authority. Credentials, broad identity grants, and
other users' profiles are excluded from the default context.

Use one schema-validated registry for capability discovery and invocation.
Discovery filters current permissions and bounds results. Invocation checks live
authorization, Allocation fencing, cancellation, host interception, and output
validation, with telemetry and activity hooks. Native deferred loading and MCP
can consume the same registry; two portable bootstrap tools are the baseline.
No full catalogue is inserted into the model context automatically.

Execution inspection uses existing Environment and Allocation services. Directory
and administration capabilities use the same registry and ordinary host policy.
The stock host exposes project-member IDs and display names to membership
managers. Custom hosts decide whether and how other people or machines are visible.
Keep the shared-authority execution model under ADRs 0098 and 0099.

## Consequences

Agents gain predictable self-context and on-demand inspection across harnesses.
Hosts can add tools without bespoke permanent tool sets or a privileged agent
role. Cached context and schemas never replace live authorization. Host executors
own resource-specific access and durable idempotency for their side effects.
