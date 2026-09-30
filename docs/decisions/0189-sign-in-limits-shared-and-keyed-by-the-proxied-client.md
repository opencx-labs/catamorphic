# 0189 — Sign-in limits are shared in Postgres and keyed by the proxied client

- **Status:** Accepted
- **Date:** 2026-09-30
- **Refines:** 0059 (stock server), 0161 (company identity)

## Context

The Work server signs people in with Better Auth, whose limiter allows three
sign-ins per 10 seconds per client address and path. In better-auth 1.6.26 it
runs only when `NODE_ENV=production`, which the image never sets, so local
password sign-in had no brute-force limit. It counts in process memory, so N
replicas allowed N times the limit. It reads the client address only from
`x-forwarded-for` and trusts that header as the client says it: with no
proxy, a client picked a fresh address per attempt; behind a CDN and an
ingress, the header had several entries, and every request fell into one
shared bucket per path (issue #150).

## Decision

**On by default, whatever the environment.** `createWorkAuth` sets
`rateLimit.enabled` from `config.authRateLimit` (default true; the image reads
`WORK_AUTH_RATE_LIMIT=off`). Tests that sign in many times turn it off through
that config, never through `NODE_ENV`. Better Auth's limits stay as they are:
three per 10 seconds on sign-in, sign-up, and credential changes, 100 per 10
seconds elsewhere. Authorization codes and refresh tokens are random, so the
token endpoint needs no stricter rule.

**Counted in Postgres.** `rateLimit.storage` is always `database`: a
`rateLimit` table in the auth schema (PGlite or Postgres), created by the
same migration as the other auth tables, whose atomic conditional increment
gives every replica one budget.

**The server names the client.** Better Auth sees only headers, never the
connection's peer, so it cannot tell a proxy's entry from a client's. The
Work server resolves the address itself and hands it over in a header it
always overwrites (`x-work-client-address`, Better Auth's only IP header).
The hops are the `x-forwarded-for` entries followed by the peer; walking from
the nearest, an entry is believed only when the hop that appended it is in
`config.trustedProxies` (`WORK_TRUSTED_PROXIES`, addresses or CIDR ranges),
and the first hop outside that list is the client.
With no trusted proxies the client is the peer and the header is ignored.
Passing the list to Better Auth's own `trustedProxies` instead was rejected:
it would believe a forged chain from any client that reaches the server
directly.

## Consequences

- Every `/api/auth` request costs a read and a conditional update in the
  auth schema.
- An office behind one NAT shares one sign-in budget, as with any
  address-keyed limit.
- A deployment behind proxies must list them; the setup skill's stock server
  and cluster references say how, and what happens when they are missing.
- Per-account lockout (independent of address) is not part of this; it would
  need its own table and an unlock path.
