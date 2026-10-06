# 0207 — Operations are sealed to their executor; worker credentials rotate

- **Status:** Accepted
- **Date:** 2026-10-06
- **Refines:** 0164, 0184, 0187, 0192, 0193

## Context

Every sandbox operation for a worker or a member's runner waits in a
Postgres row until the executor takes it (ADR 0187). Its payload leaves the
row once it runs, but Postgres keeps it in its write-ahead log and backups,
and payloads now carry secrets and personal files (ADR 0206). A worker's
credential was a static bearer for life. Each operation also waited for
polling on both sides, which a terminal (ADR 0209) cannot afford.

## Decision

**Sealed to the executor.** Every executor holds an X25519 key pair; the
private key never leaves its machine (a worker's data directory, a member's
desktop profile). A worker registers its public key when it enrolls or
rotates; a member's runner when it connects. Public keys live in
`executor_keys`, by queue address. Each operation is stored sealed to the
key current when it is queued: an ephemeral X25519 agreement, HKDF-SHA256,
and AES-256-GCM with the operation's id, executor and kind as associated
data. A row holds the kind in the clear and the ciphertext; Postgres, its
log and its backups hold nothing else of it. An executor without a key
cannot connect and receives nothing; a worker presenting another key than
the one it enrolled with is refused. Receipts stay plain: their results
enter the session log anyway. Their errors lose any URL's credentials on
the executor and again before they are stored, and a failed clone never
names its credentialed URL. Workers older than this speak protocol 1 and
are refused.

**Credentials rotate.** A worker replaces its credential and key pair when
its credential is 30 days old and when the operator asks
(`POST /_work/operator/workers/:name/rotate`): the control plane says so in
its answers to connect, poll and renew, never by refusing work. The worker
generates a key pair and calls `POST /api/workers/rotate` with a UUIDv7
rotation id; the new credential stays pending beside the current one, and
only a later id replaces it, so a request delayed on its way never
replaces the credential a later one issued. The worker writes the new
credential and key to disk, beside the pair they replace, before using
them; their first use makes them current and ends the old credential, so
a lost response never strands a worker. Should the control plane still
refuse the new credential, the worker goes back to the old one, which was
never ended, and rotates again. It keeps keys it rotated away from for 35
minutes, the longest an operation other than a long command waits; an
operation the executor can no longer open did not run, so its controller
seals it again to the current key.

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
