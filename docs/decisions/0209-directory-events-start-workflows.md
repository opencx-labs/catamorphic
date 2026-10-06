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
when an account becomes active (its first sign-in, or a sign-in the directory
approves after it was disabled), `directory.member-left` when it is disabled,
and `directory.groups-changed` when an active member's directory groups change
(`added`, `removed`). Each carries the member's id, email, name, email domain
and current groups: the groups the server asks the directory about, which
include groups a directory binding names; a group it starts or stops asking
about is no change. They are durable project events (ADR 0171), appended only
to projects with an active subscription, so each subscribed automation sees a
change once. The transaction that records a transition (an account row counts
its transitions, which name each event) queues its event in an outbox;
delivery to projects happens after commit and retries with backoff, so a
failed delivery never undoes the transition (a departed member stays disabled
and signed out), and one account's events are delivered in order. A `groups`
config narrows them to members of any of those groups (`where` cannot test
arrays) and `where` narrows the rest (a domain). A trigger kind may require
permissions of its subscribers (`requiredPermissions`); these require
`memberships:read`, which the deploy scan and the project check enforce. The
sweep checks every member who joined and is not disabled, signed in or not,
so a departure is always noticed.

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
their own directories fire the same kinds through their `DirectoryProvider`,
or register `DIRECTORY_TRIGGER_KINDS` and append `directoryProjectEvent`s
with `projectEvents.appendToSubscribers`. Changes from before an automation
is turned on are not replayed. The sweep asks the directory about every
member each interval, not only those signed in. A project with a directory
automation sees the email, name and groups of everyone on the server, so
`memberships:read` (and publishing) in such a project amounts to reading the
directory; requiring an organization administrator to turn these on was
considered and left out, since control-plane permissions are not part of
enablement checks today.
