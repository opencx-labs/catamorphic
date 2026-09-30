# 0192 — Workers own their lease: any replica runs any worker's turns

- **Status:** Accepted
- **Date:** 2026-09-30
- **Supersedes:** 0164's "the control-plane instance a worker connects to holds that node's lease, runs its agents' controller loops" and its session pinning
- **Refines:** 0098, 0164, 0173, 0187, 0190

## Context

Only a worker's `/connect` took its node lease, and it lived in the memory
of the replica that answered. That replica alone claimed the worker's
turns, built its sandbox provider, and released and destroyed its idle
workspaces. When it stopped, the worker's agents stopped until the lease
lapsed and the worker happened to connect elsewhere. A member's This machine
chats were likewise placed on the node of the replica that admitted them.

## Decision

**The worker owns its lease.** A worker process chooses an *epoch* when it
starts, a UUIDv7, and connects with it to any replica; the machine
credential is the authority. The epoch is the node's lease token. The same
epoch connecting again only refreshes the worker's offer. A later epoch (a
restarted process) takes over at once and, in the same transaction, fails
every operation the old epoch was sent as uncertain: none is delivered again,
and late receipts are refused. An earlier epoch is refused while the current
one is live, so a stale process stops for good instead of taking the machine
back; after a lapse any epoch may connect. Every poll, renewal, and receipt
renews the lease while its epoch is current. The lease lapses 45 seconds
after the worker stops calling. No replica keeps a worker in memory.

**Remote nodes are built from rows.** `worker_nodes.remote` records the
executor's offer (workspace root, background processes). Any replica builds
the node's forwarding provider from it; each operation is addressed to the
current epoch and fails at once while the lease is not live.

**Any replica runs a remote node's turns.** The `agent_turns` claim decides,
in Postgres. A turn may be claimed when its workspace is on no node, on a
remote node that is enabled with a live lease, or on the claiming process's
own local node. So turns wait while a worker is away, and a replica's own
node stays its own. A running turn is fenced by its own turn lease; the
epoch fences operations, not turns, so a worker restart fails the operation
in flight and never the turn wholesale. A replica that stops lets its own
turns finish or interrupts them (0190); a turn whose replica crashed is
settled by another after its lease lapses, through ordinary turn-lease
recovery: interrupted, never replayed.

**Maintenance runs under claims.** Any replica releases idle workspaces
(ADR 0173) and destroys released ones on remote nodes, each Allocation under
a row claim with expiry (`maintenance_claimed_until`). A turn claim
share-locks its session row, so an idle release and a claim never overlap.

**This machine is no replica's node.** A member runner already owned its
lease. Its chats' Allocations name no node, so any replica runs their turns
while the runner's lease is live, and they hold no replica capacity. A
member's machine is not idle-released; the runner stops its sandboxes when
it disconnects.

Considered: letting any replica take a lapsed worker's lease on the
worker's behalf. Rejected: only the worker knows whether its process
restarted, and only a new process may make its predecessor's operations
uncertain.

## Consequences

Stopping any replica interrupts only the turns that replica was running.
A worker's restart costs the operations in flight, not its chats: sandboxes
persist and the next turn continues. A turn that moves to another replica
re-anchors its harness and refreshes the workspace's files from the session
branch, so an interrupted turn's uncheckpointed edits are not kept. Session
copies on a replica's disk remain until issue 153; turn status and in-memory
guards remain until issue 154. Workers and control planes must run the same
release.
