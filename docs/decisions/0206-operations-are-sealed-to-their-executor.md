# 0206 — Operations are sealed to their executor; worker credentials rotate

- **Status:** Accepted
- **Date:** 2026-10-06
- **Refines:** 0164, 0184, 0187, 0192, 0193

## Context

Every sandbox operation for a worker or a member's runner waits in a
Postgres row until the executor takes it (ADR 0187). Its payload leaves the
row once it runs, but Postgres keeps it in its write-ahead log and backups,
and payloads now carry secrets and personal files (ADR 0205). A worker's
credential was a static bearer for life. Each operation also waited for
polling on both sides, which a terminal (ADR 0208) cannot afford.

## Decision

**Sealed to the executor.** Every executor holds an X25519 key pair; the
private key never leaves its machine (a worker's data directory, a member's
desktop profile). A worker registers its public key when it enrolls or
rotates; a member's runner when it connects. Each operation is stored sealed
to that key: an ephemeral X25519 agreement, HKDF-SHA256, and AES-256-GCM with
the operation's id and executor as associated data. Postgres, its log and its
backups hold only ciphertext. An executor without a key receives nothing.
Receipts stay plain: their results enter the session log anyway.

**Credentials rotate.** A worker replaces its credential and key pair every
30 days on its own, and when the operator asks
(`POST /_work/operator/workers/:name/rotate`, answered at the worker's next
call). The old credential keeps working until the new one is first used, so
a lost response never strands a worker.

**Local wakeups.** A replica that queues or settles an operation wakes its
own waiting polls and controllers at once, as working state of requests it
is serving (ADR 0193). Other replicas still find the rows by polling, so
correctness never depends on the wakeup.

Considered: sealing receipts too (the session log stores their content
anyway), and per-operation keys from the vault (the control plane would hold
what decrypts every queued payload).

## Consequences

A database dump reveals no queued file, secret or command. Losing a worker's
data directory means enrolling it again. A single replica forwards an
operation in one network round trip each way; several replicas fall back to
polling for operations queued on another.
