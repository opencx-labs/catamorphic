# 0190 — Disposable control-plane replicas

- **Status:** Accepted (amended by [0197](0197-agent-runners-run-harnesses-beside-their-workspace.md))
- **Date:** 2026-09-30
- **Supersedes:** 0099's "local checkouts and runtime files are instance-owned working state" for control-plane replicas
- **Refines:** 0100, 0164, 0167, 0173

## Context

A control-plane replica on network Postgres could not be replaced by a fresh
process with an empty disk. Its node id came from a file in its data
directory, so a new pod was a new node, and nothing recovered the old one.
Workflow runs and control-plane chats are placed on one node, and only that
node claims their work: a paused durable run on a replica that never came
back stayed running forever and kept its tenant's run capacity. A replica
whose lease lapsed stayed unhealthy while `/healthz` answered 200, and each
replica without `WORK_OPERATOR_SECRET` generated an operator credential of its
own.

## Decision

**Allocations stay bound to a node; losing a node is an ordinary event.** A
sandbox physically lives on one machine, so placement is unchanged.

- **A replica's node lives one process.** On network Postgres each start
  registers `node.<uuid>` as a *disposable* node, labelled `plane=control`,
  and writes no identity to disk. Its data directory holds only working
  copies and sandboxes; sandboxes left by an earlier process are removed at
  start, so two replicas never share a data directory. A single PGlite
  server keeps its machine identity in its data directory: its disk is
  durable and its sandboxes survive a restart. It takes its lease again
  after a lapse, and idles while an operator has it disabled.
- **Stopping gives the node back.** SIGTERM stops claiming (in-flight jobs
  return to the queue), lets running chat turns finish (then interrupts
  those still running, within 15 seconds), releases the lease and disables
  the node, recovers it at once, and destroys the sandboxes it held.
- **A job stops before its lease could lapse.** A workflow step aborts once
  its last landed renewal is older than five sixths of the job lease, so a
  process frozen past its lease never acts after another took the job.
- **Any replica recovers lost nodes** each ten seconds, under row locks on
  each Allocation and node. A disposable node is lost once it released its
  lease, or its lease lapsed more than 30 seconds ago. Each pass takes the
  lost nodes it looked at longest ago, so ones whose work cannot move yet
  never starve others. For each:
  - its Allocations are released with reason `node_lost`, their capacity,
    connection grants, and allocation-scoped deployment runtimes with them;
  - each workflow run is admitted again in its own Environment, as its owner
    now resolves (a project automation as the project) and placed for that
    owner, keeping its connections and enablement. Its sandbox is rebuilt from
    the deployed artifact and its step journal carries on; an uncertain step
    behaves as after a restart on the same machine (attempt-neutral lease
    expiry). A run no machine can take now waits for a later pass; one its
    Environment can no longer place, or whose owner may no longer act, fails
    with the reason, while its Allocation is still locked on the lost node;
  - a chat is admitted again on its next turn and restores its workspace
    from `sessions/<id>` (ADR 0173);
  - the node row is deleted once nothing active is left on it.
- **Liveness is the lease; readiness is renewing it.** `/healthz` answers
  503 only once a disposable node's lease is lost, which it can never renew:
  the database refused a renewal, or none has landed for the 45 second lease
  (a hung connection counts). The Work server image then interrupts its
  turns at once and exits so its supervisor starts a fresh process; any
  shutdown ends within 25 seconds.
  `/readyz` answers 503 while renewals fail or hang, or the machine is
  disabled, so a database failover shorter than the lease takes replicas out
  of rotation without restarting them.
- **`WORK_OPERATOR_SECRET` is required with `DATABASE_URL`.**

Considered: moving Allocations between nodes without releasing them. Rejected:
the old sandbox, its creation fence, and its runtimes name a machine that no
longer exists. Considered: a replica re-registering its node after a lapse.
Rejected: another replica may already be recovering it.

## Consequences

A replica can be replaced at any time. On Kubernetes, the liveness probe
is `/healthz`, the readiness probe `/readyz`, and
`terminationGracePeriodSeconds` of at least 30 gives stopping replicas time
to settle their turns and move their work. Chats on a lost replica lose uncheckpointed sandbox
state, exactly as after an idle release; a replica restart rebuilds its
sandboxes. Workers keep stable identities and are not reaped. Member drafts
are refs in the project origin (ADR 0191), so no replica holds one.
