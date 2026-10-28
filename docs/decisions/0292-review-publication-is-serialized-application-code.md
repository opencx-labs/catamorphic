# 0292: Review publication is serialized application code

- **Status:** Accepted
- **Date:** 2026-10-28

## Context

The review recipe reads verdicts before writing them. Overlapping runs can both
observe no verdict and publish a failure followed by a success. GitHub stamps
find earlier writes on retry but do not exclude concurrent writers. GitHub
creates are not transactions with the application's database.

## Decision

Ship a project-owned publisher as ordinary Work server hook code alongside the
review recipe. It uses a separate application Postgres schema, the existing
host-call primitive, and the connection broker. It serializes publication per
project and pull request, records stable effect identities and destination ids,
checks the current head and review generation, and persists a commit's strongest
verdict before dispatch. The workflow remains the durable orchestration entry.
A pinned transaction holds the row lock, with separate connection pools for
locks and independently committed ledger writes so waiters cannot starve the
intent commit. No framework review tables or universal external-effects engine
are introduced.

Commit effect intent before each outbound create. After an uncertain result,
reconcile the effect's exact stamp with the destination. If no receipt is found,
keep the effect uncertain and require reconciliation; never infer absence from
a single list response and issue another create. Database ownership does not
fence a request GitHub has already accepted. Disable unattended mutable summary
replacement, dismissal and thread resolution in the default recipe: commit-bound
reviews, checks and replies remain advice; people retain control of earlier
change requests and threads. A custom publisher can add those policies.

## Consequences

Deployments install the small publisher module and its application schema in
their owned server. Tests interleave writers, change heads and interrupt the
receipt path after an accepted create. Uncertain effects can require operator
attention rather than silently duplicate. This is normal host/workflow glue,
not a new native integration requirement or an exactly-once GitHub guarantee.
