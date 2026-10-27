# 0293: Model grants end with their turn attempt

- **Status:** Accepted (amends 0180 and 0255)
- **Date:** 2026-10-28

## Context

A sandbox may keep background processes after a review turn ends. ADR 0180
deliberately allowed model requests between turns. That gives those processes
model authority until the session releases its Allocation, and a check for any
running turn would let an old bearer regain authority when the next turn starts.

## Decision

The existing connection grant carries an optional model fence: the exact turn,
attempt and claimed lease token being prepared. Model requests require that
fence, the same session and active Allocation, a live uncancelled turn lease,
and the same live attempt. Preparation passes its actual claim, never a lookup
of the latest turn. Each renewal retains that fence. Settling, interruption,
lease expiry, replacement and Allocation release therefore deny new model
requests on every replica. An unbound grant has no model authority.

Git, HTTP and MCP keep their existing grant lifetime, including on aliases
that also serve models. They remain usable by authorized background work.
Usage belongs to the grant's turn, even when its answer ends after that turn.
Issuance checks the fence under a turn lock; stale renewal cleanup cannot
revoke a later generation's grants. A surviving runner receives grants for its
new claim and restarts renewal before takeover continues.

Grant rows carry a monotonic publication revision. Each bearer is an immutable
file named by that revision in an alias's grant directory. Uploads stage files,
then atomically add the finished revision; readers select the greatest numeric
revision on every use. Delayed old uploads cannot displace newer model, Git or
HTTP authority. Model directories are attempt-specific; a takeover adds the new
lease's revision to the surviving attempt's directory. Cleanup revokes only
older grant revisions. The runner's model contract is `grantDirectory`, and
HTTP exposes `_GRANT_DIRECTORY` with a reader helper. There is no mutable
current-token file, pointer, filesystem mutex or legacy file fallback. This
incompatible `AttemptStart` change bumps the runner protocol to version 2.

Authorization is checked again after body processing and guards, immediately
before forwarding. Calls already admitted may finish streaming after a turn
ends. Consumer cancellation closes the upstream response stream; this decision
does not promise immediate cross-replica cancellation of admitted requests or
undo provider work. Hosts continue to own spend policies through guards.

## Consequences

Idle and abandoned sandbox processes cannot start fresh model requests with
an earlier bearer. This intentionally breaks ADR 0180's between-turn model
access. A sandbox remains one trust boundary: processes able to read a future
turn's new grants share that turn's authority. Resource isolation and independent
cleanup remain necessary. No second token mechanism or built-in budget is added.
