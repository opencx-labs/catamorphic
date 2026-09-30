# 0193 — No cross-replica state in replica memory

- **Status:** Accepted
- **Date:** 2026-09-30
- **Refines:** 0099, 0173, 0190, 0192

## Context

Control-plane replicas sit behind a load balancer that sends each request to
any of them (ADRs 0190, 0192), but several facts lived in one replica's
memory. Whether a chat was running came from an in-memory set, so `running`
flickered between polls, and guards in update, mirror, handoff and retry
missed turns on other replicas. Close and archive waited only for local
turns, then released the workspace and withdrew personal logins under a turn
running elsewhere. An interrupt reached a quiet turn on another replica only
at its next 15 second heartbeat. In-process locks did not exclude other
replicas (a publish could create two repositories; two replicas could each
create a deployment runtime), the company project sync ran on every replica,
role and program caches expired on a timer and were invalidated only
locally (a This machine registration right after a deploy was refused as
stale), and model usage totals waited only for local writes. A parked Claude
Code question lived in one process with nothing routing its answer there.

## Decision

**The rule.** A control-plane replica's memory holds only (a) the working
state of work it claimed through a Postgres lease, or of a request it is
serving, rebuildable if lost; (b) caches keyed by content hash or database
revision; (c) registries built identically at boot on every replica.
Anything observable, fencing-relevant, or mutually exclusive across replicas
lives in Postgres: row claims with expiry, or transaction-scoped advisory
locks, never session-level ones. Workers may hold local state. In-memory
implementations of injectable stores (a vault, a permission broker) are for
single-process hosts.

- **Turn status is the lease.** A chat is running while a turn is `running`
  with a live lease and not `parked` (below). A turn `waiting` inside its
  harness (a blocking ask) runs. Guards read this inside the transaction
  that writes the change; a turn claim share-locks the session row.
- **One renewal per process.** Each process renews every turn it runs in one
  statement a second, which returns their cancellation flags: an interrupt
  through any replica reaches a quiet turn within about a second. No
  LISTEN/NOTIFY, so it works through a transaction pooler. Renewal leaves
  `updated_at` alone; idle release skips any chat with a live turn.
- **Close and archive wait on Postgres.** They request cancellation durably
  and wait for leases to end. A chat's workspace, sandbox and personal
  logins are given back only once no turn runs in it, under the chat's
  `close:<id>` claim: by close, by the process running its last turn, or by
  any replica's sweep if that process died. An archive whose turn did not
  stop keeps the workspace until idle release.
- **Singleton work under claims.** `replica_claims` holds named claims with
  an expiry, renewed while their work runs: publishing a project, creating
  a deployment runtime (taken before any sandbox exists), and each company
  project's sync (the claim is the schedule). Work whose claim lapses or is
  taken over is aborted before its next exclusive write. Locks guarding a
  replica's own disk (mirrors, working copies) stay in memory.
- **Caches by revision.** Roles are cached per published commit, and every
  resolve reads the current one (one ref read; concurrent reads of a
  project share it); a working tree's roles are keyed by their files' hash.
  The program reader fetches only when its copy is behind. Nothing needs
  invalidating: hosts lose `rolesCacheTtlMs` and `roles.invalidate`.
- **Usage totals from Postgres.** A model call's usage row opens before its
  answer ends and settles after; totals wait for open rows on any replica,
  ignoring rows open longer than a call can stream (30 minutes).
- **Parked questions keep their turn.** When a harness holds a question in
  memory (Claude Code's parked AskUserQuestion), the asking turn stays
  claimed in phase `parked` with its lease renewed; the next queued message
  is claimed there in the transaction that settles the question. A stop
  with nothing queued, a lost lease, a stopping process, or a changed chat
  settles it instead, and the answer resumes elsewhere.
- **Enforced.** A repository test fails on a class-level or module-level
  `Map` or `Set` in core services or the Work server without a comment
  classifying it.

Considered: LISTEN/NOTIFY for interrupts. Rejected: it breaks behind a
transaction pooler and still needs a fallback poll.

## Consequences

Any replica answers any request about a chat the same way. A process renews
its turns with one indexed statement a second. A role resolve costs one more
indexed read on a Postgres object store (about 0.4 to 0.8 ms); on S3 it is a
GET per resolve. A replica that dies mid-close leaves a chat's workspace held
until another replica's sweep, about a minute. Session copies on a replica's
disk remain until issue 153.
