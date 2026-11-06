# 0279 — Public pull request status needs no sign-in

- **Status:** Accepted
- **Date:** 2026-10-24
- **Extends:** [0239](0239-chips-are-a-source.md)

## Context

A recorded pull request can still say open after it merges when a profile has
neither a readable code-host connection nor the GitHub CLI connection enabled.
The desktop silently showed the agent's recorded metadata as if it were live.
The person approved reading public GitHub pull requests without signing in.

## Decision

Keep the existing read order: the person's code-host connection, then the
GitHub CLI only when enabled. If those cannot read a github.com pull request,
use the same GitHub client without an Authorization header to read its public
status. Never enable credentials or change the person's connection settings.
Private pull requests still need an authorized connection or CLI account.

The desktop's existing per-URL query owns the cache. It receives the access
source with the status, so anonymous reads refresh every five minutes rather
than every minute, and omit the extra check-run requests. A rate limit or
transient failure keeps the last good status. Merged pull requests stop polling;
closed ones can reopen and continue refreshing. Recorded-only chips say so.

We rejected requiring a sign-in for public information and parsing GitHub HTML
instead of using the existing REST client.

## Consequences

Public chips show their current state without setup. Anonymous GitHub rate
limits can delay a refresh; authenticated connections retain faster updates and
check details. No new credential store, status cache, or code-host abstraction
is introduced.
