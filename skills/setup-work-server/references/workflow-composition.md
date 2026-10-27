# Compose a service from Work primitives

Work publishes libraries. A deployment owns its small TypeScript entry point,
dependencies and image. Missing native integrations are usually application
code: workflows run ordinary TypeScript with npm packages and full IO.
Recipes are starting points, not a catalog of the only supported use cases.
Inspect the installed contracts before describing a limitation as a blocker.

## Choose where the code belongs

| Concern | Existing primitive |
| --- | --- |
| Events, webhooks, schedules, retries, durable progress | Project TypeScript workflows, immutable deployed revisions, boundaries and returned transitions |
| Calling an ordinary external API | An npm SDK or HTTP inside a step helper, within the workflow's declared network and secret policy |
| Service credentials and reviewed access | A connection provider through `hooks.connectionProviders`; workflow `connections` and Environment bindings |
| Privileged host operations without giving credentials to the workflow | SDK capability providers through `hooks.capabilityProviders`; returned `context.host` calls |
| Authenticated callbacks or application HTTP endpoints | `hooks.routes`; verify the sender and persist acceptance before acknowledging |
| Jobs, desired state, receipts, inboxes, publication effects | Application-owned Postgres tables in a separate schema or database |
| Work-managed sandboxes and chat lifecycle | Enrolled workers, Environments, allocation admission and agent sessions |
| A process managed by the application itself | Workflow SDK calls to launch/observe/stop it; Work worker enrollment is unnecessary |
| Company identity, policy, request rewrites | The host's typed hooks, or mount the lower-level SDK in an existing application |

`agentCapabilities` exposes agent tools; `capabilityProviders` serves workflow
host calls. They are different contracts. A host function receives its caller
from core, but must enforce access to the resource itself. Keep ordinary AWS,
database and GitHub write credentials off machines executing untrusted PR code.
Do not invent configuration fields or bypass authorization to bridge a service.
See [the library guide](../../../packages/work-server/README.md) for setup.

## Example: external review runners

A Porter-hosted Work server can orchestrate AWS EC2 reviews while an
application Postgres ledger records jobs. No native EC2 integration is
required. Keep the existing review/merge/verify algorithm on the runner if
it already works. A Work agent worker is an alternative when the runner
should participate in Work's own sessions and sandbox management.

A clean application sequence:

1. Verify incoming events, deduplicate deliveries and persist desired PR head,
   generation and attempt identity. Persist intent before enrolling a workflow.
2. Run bounded controllers that claim due work with expiring database leases.
   Store immutable launch parameters and an operation token before calling AWS.
   Reuse both across retries; a new intentional attempt gets a new token.
3. Observe resource receipts and actual provider state after ambiguous outcomes.
   Tag resources with deployment, job, attempt and expiry. Bound concurrency,
   boot time, stage time, total job duration and spend.
4. Dispatch runner commands with stable command ids. Validate every artifact
   against job, attempt, generation and exact source SHA. An old attempt cannot
   publish for a new head.
5. Authenticate callbacks to their attempt and insert them into an inbox before
   returning success. Polling or reconciliation must also recover lost callbacks.
6. Serialize publication by repository/PR. Store effect identity, intended
   verdict and destination object ids. Reconcile an accepted write whose response
   was lost before creating another object. A read-before-create stamp races.
7. Reconcile cleanup independently of the main run: superseded, terminal,
   expired and orphaned resources stay due until termination is observed.
   Inventory tagged resources absent from the ledger. Add an independent expiry
   mechanism when a control-plane outage must not leave compute running.

Do not hold database transactions over external IO. Database leases need
fencing/generation checks before effects, not just a timeout. An external API
may accept an action after a local timeout or cancellation: reconcile the
outcome instead of assuming it failed.

AWS `RunInstances` idempotency is scoped by Region and, when a subnet or AZ is
specified, Availability Zone. Preserve that scope along with the token and
parameters; changing zones with the same token can create another instance.
See [AWS's idempotency contract](https://docs.aws.amazon.com/ec2/latest/devguide/ec2-api-idempotency.html).

## Current guarantees and limits

- Boundary results, retries/backoff, waits, child continuations and execution
  leases are durable. A `"use step"` helper is visual detail within one retry
  boundary, not its own checkpoint.
- A boundary callback and its returned host, document or connection call share
  one persisted five-minute attempt deadline. Providers receive cancellation and
  that deadline; job lease loss/cancellation is observed through heartbeats.
  The host bounds its await even when a provider ignores abort. Synchronous code
  cannot be preempted, and an accepted external action still needs reconciliation.
- Named signals can buffer before a matching pause within an existing active run
  generation. Send the enrollment receipt's run id with the correlation key and
  a stable callback id. A host kickoff hook receives that run id in its stamped
  context. Receipts deduplicate delivery; each event resumes one pause. A restart
  never inherits the previous run's inbox. Use an application inbox when
  acceptance must survive beyond that generation or exceed its bounded inbox.
- A correlation key deduplicates live runs, not permanent business jobs. Restart
  commits cancellation and replacement enrollment together; failure rolls back
  both. External side effects are separate. After an uncertain enrollment
  response, inspect the active generation and reconcile the application's
  desired state rather than blindly requesting another restart.
- Durable waits give back their shared physical workspace after confirmed
  teardown, once all root, child and batch compute waits. Continuations receive
  fresh owner, Environment and connection admission with the same artifact and
  journal. Workspace files and processes do not survive parking; failed teardown
  still holds capacity. Logical active-run limits still count waiting runs.
- Neither an external Postgres ledger nor a retry boundary makes an external
  write exactly once. Side-effect identities and destination receipts remain
  application responsibilities.
- Container sandboxes enforce supported CPU/memory limits but reject disk quotas.
  Disposable per-job machines and bounded volumes provide a deployment limit.
- New sandbox model calls require the issuing turn attempt and its live lease.
  Idle calls and old bearers on later turns are denied. Already admitted streams
  may finish; Git and HTTP background grants retain their ordinary lifetime.
  End-of-job cleanup must release resources; provider spending policy stays in
  host guards and provider limits.

## External Postgres and deployment

Use one dedicated database with Work's own schemas and a separate application
schema, or a separate application database when isolation/lifecycle calls for
it. The integration uses public Work APIs, never writes to internal tables.
Keep database credentials off untrusted runners. Separate databases require
persisted intent and reconciliation across the write/enrollment boundary too.

Neon is ordinary network Postgres. Begin with its direct endpoint for Work
and migrations. Work's pools configure schema search paths, while Neon's
transaction pooler does not preserve arbitrary session settings and session
advisory locks. Validate your actual configuration before using pooled Work
connections. Schema-qualified application queries with transaction-scoped
claims can be designed for pooling. See
[Neon's pooling limits](https://neon.com/docs/connect/connection-pooling).

On Porter, use stable shared signing/vault/operator secrets and network
Postgres for disposable replicas. Keep the setup listener private, use
`/readyz` for readiness, and stop on SIGTERM or `server.lost`. Bound shutdown
before the platform's forced termination and test ingress body/stream/polling
limits. Workflow-only control planes and credential-less execution machines
preserve the trust separation. See [Porter's deployment lifecycle](https://docs.porter.run/applications/configure/zero-downtime-deployments).

## Prove the final deployment

Test duplicate/out-of-order events, callback-before-wait, lost create responses,
crash-after-effect-before-receipt, cancellation during IO, newer pushes during
publication, lost/hung runners, replica replacement, PR closure and orphan
cleanup. Assert actual provider termination and correct destination objects,
not only a terminal Work run. Exercise the selected database endpoint, pools,
maximum concurrency and cleanup capacity. Local fixtures and a live model
smoke test establish only the paths they execute, not the complete deployed chain.
