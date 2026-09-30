# 0190 — Disposable control-plane replicas

- **Status:** Accepted
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
  start. A single PGlite server keeps its machine identity in its data
  directory: its disk is durable and its sandboxes survive a restart.
- **Stopping gives the node back.** SIGTERM stops claiming (in-flight jobs
  return to the queue), releases the lease, and disables the node, then
  recovers it at once.
- **Any replica recovers lost nodes** each ten seconds, under row locks on
  each Allocation and node. A disposable node is lost once it released its
  lease, or its lease lapsed more than 30 seconds ago. For each:
  - its Allocations are released with reason `node_lost`, their capacity,
    connection grants, and allocation-scoped deployment runtimes with them;
  - each workflow run gets a new Allocation in its own Environment on a live
    node, keeping its connections and enablement. Its sandbox is rebuilt from
    the deployed artifact and its step journal carries on; an uncertain step
    behaves as after a restart on the same machine (attempt-neutral lease
    expiry). A run no machine can take now waits for a later pass; one its
    Environment can no longer place fails with the reason;
  - a chat is admitted again on its next turn and restores its workspace
    from `sessions/<id>` (ADR 0173);
  - the node row is deleted once nothing active is left on it.
- **A lapsed lease ends the process.** It can never be renewed: `/healthz`
  answers 503 and the Work server image exits, so its supervisor starts a
  fresh process. `/healthz` also answers 503 while renewals fail.
- **`WORK_OPERATOR_SECRET` is required with `DATABASE_URL`.**

Considered: moving Allocations between nodes without releasing them. Rejected:
the old sandbox, its creation fence, and its runtimes name a machine that no
longer exists. Considered: re-registering the same node after a lapse.
Rejected: another replica may already be recovering it.

## Consequences

A replica can be replaced at any time; a Kubernetes liveness probe on
`/healthz` suffices. Chats on a lost replica lose uncheckpointed sandbox
state, exactly as after an idle release; a replica restart rebuilds its
sandboxes. Workers keep stable identities and are not reaped. Member draft
working copies on a replica's disk remain until issue 148.
