# 0347 Machines are decided and made by host code

- **Status:** Accepted
- **Date:** 2026-11-20
- **Supersedes:** machine policy in [0167](0167-machine-pools-access-and-owner-placement.md), [0205](0205-machine-classes-pools-and-retention.md), [0258](0258-machines-on-demand.md), and [0327](0327-machine-provisioners-are-workflows.md).
- **Amends:** 0164, 0294, and 0346.

## Context

An organization can size, assign and retain machines based on its own work.
Classes, directory-backed rules and workflow trigger bindings forced the
server to understand each new policy and provisioning platform.

## Decision

A host passes one `hooks.machines` object to Work. Its `plan` receives
serializable facts about waiting work, known machines, accounts and project
roles. It returns the desired machines by stable name. Its idempotent
infrastructure verbs create, destroy and optionally stop, start and describe
machines. Work records create intent and enrollment before calling a verb,
and sequences changes under a renewed, fenced replica claim.

Workers serve specific users, a project's own work, specific project chat
keys, or anyone whose role and Environment allow them. Work owns capacity,
enrollment, placement, safe draining, reset before a change of owners, and
retirement of lost work. Work still accepts hand-enrolled workers. With a
machines hook, an Environment that omits its wait bound inherits the
server's default. Lifecycle events go to the projects named in a machine's
principals and optionally to the host.

## Consequences

Cloud calls, any directory lookup for machine policy, and the choice to run
a verb through a project workflow live in host code. The registry ships
copyable recipes and Work exports a contract kit. Existing enrolled workers
become hand-enrolled at migration. Previous email and group policies must
be expressed again using users and project principals.
