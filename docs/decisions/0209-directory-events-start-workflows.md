# 0209 — Directory events start workflows; workflows set members' secrets

- **Status:** Accepted
- **Date:** 2026-10-06
- **Refines:** 0158, 0161, 0171, 0205

## Context

Onboarding is automation: when an engineer joins, issue their ClickHouse key;
when they leave, revoke it. Workflows could start from schedules, chats and
webhooks, but not from the directory, and no workflow could give a member a
value of their own.

## Decision

**Directory trigger kinds.** The Work server fires `directory.member-joined`
when an account becomes active (its first sign-in, or re-enabled in the
directory), `directory.member-left` when it is disabled, and
`directory.groups-changed` when its directory groups change (`added`,
`removed`). Each carries the member's id, email, name and current groups.
They are durable project events (ADR 0171), appended only to projects with an
active subscription, so each subscribed automation sees a change once, and
`where` filters narrow them (a group, a domain). A workflow subscribing to
them must declare `memberships:read`.

**Workflows set secrets.** `host["catamorphic.secrets"]` offers `list()`,
`set({ name, value, member? })` and `delete({ name, member? })` on the
project's secrets (ADR 0205), naming a member by id or email; the host
resolves an email to its user (`memberIdForEmail`, which the Work server
answers from its sign-ins), and the member must belong to the project. Runs
get them only if the workflow declared `secrets:read` or `secrets:write` and
the enabling member holds them (ADR 0158). Values set this way are
write-only like any other.

Considered: polling the directory from a scheduled workflow (every project
would need directory credentials and its own diffing) and an organization-wide
secret store (one project's automation would then write every project's
values).

## Consequences

An onboarding workflow mints a key on `directory.member-joined`, stores it as
the member's value, and revokes it on `directory.member-left`. Hosts with
their own directories fire the same kinds through their `DirectoryProvider`.
