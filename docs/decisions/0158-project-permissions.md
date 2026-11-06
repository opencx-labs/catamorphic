# 0158 — Project permissions: read, write, publish, and what workflows declare

- **Status:** Accepted
- **Date:** 2026-09-24
- **Supersedes:** the `builder` role flag and project ref of 0055, the `memberships:manage` / `roles:manage` names of 0072, the `when.builder` predicate of 0092, and the `connections:manage_service` / `connections:view_audit` names
- **Builds on:** 0053 (identity scope), 0055 (roles as files), 0156 (project automations)

## Context

A role could say `"builder": true`, which expanded to a project ref meaning
"may do everything to the program": edit files, publish, set secrets, read
everyone's chats and runs. Two more permissions (`memberships:manage`,
`roles:manage`) sat beside it with a different shape. There was no way to
let someone edit but not publish, read runs but not secrets, or act on other
people's chats without making them a builder.

Workflows ran with whatever their caller held. A project automation that
should post into the chats of the members it reviews had no way to ask for
that, and a member's automation carried every power of its member.

## Decision

**One vocabulary.** A project permission is `thing:action`. Catamorphic
enforces these things:

| Thing | `read` | `write` | `publish` |
| --- | --- | --- | --- |
| `program` | source, history, definitions | edit the working copy, branches, app builds | make it live: deploy, plugins, app versions, rename |
| `secrets` | which secrets exist | set and delete values | |
| `automations` | everyone's automations | turn project automations on, pause, update | |
| `webhooks` | webhook URLs (credentials) | replace them | |
| `runs` | everyone's runs | cancel, pause, resume, signal anyone's | |
| `sessions` | everyone's chats | deliver into, interrupt, archive anyone's | |
| `memberships` | the member list | invite, grant, revoke | |
| `roles` | the role files | change them; assign roles that carry permissions | |
| `publications` | everyone's publications | revoke anyone's | |

`write` and `publish` each imply `read` on the same thing. Nothing else
implies anything: `publish` does not imply `write`, and no permission implies
another thing. A role may grant `thing:*` or `*`. Embedders keep their own
namespaced names (`brain:maintain`), which Catamorphic stores and reports but
never interprets. The words `manage` and `builder` are gone.

**Artifacts stay refs.** `agents`, `workflows`, `apps` and `environments` in a
role accept `"*"` for every one of that kind. The store stays reachable only
through `documents`. An admin role is plain grants:
`{ "agents": ["*"], "workflows": ["*"], "apps": ["*"], "permissions": ["*"] }`.
The root identity (no scope) still holds everything.

**Role files guard themselves.** Writing, committing or publishing any
`.catamorphic/roles/*.json` needs `roles:write`, checked against the
published diff at deploy time, whoever made the edit.

**Host-issued permissions** over tenant-wide resources are
`connections:read` and `connections:write`. Project roles cannot grant them.

**Workflows declare permissions.** `defineWorkflow({ permissions: [...] })`
names the concrete permissions its runs need (no wildcards). A run's caller
holds exactly the declared permissions it also holds; nothing else, whoever
started it. Child runs hold what the parent run holds of their own
declaration. Consent shows the list, and only an identity holding every
declared permission may turn the workflow on.

- A member's automation keeps its permissions only while the member holds
  them: every run re-checks, and a lost permission suspends it
  (`permission_revoked`).
- A project automation runs as the project principal with the consented
  permissions, not tied to whoever enabled it (0156). Turning one on needs
  `automations:write` plus every declared permission.

This lets a permitted workflow read the sessions table and deliver into
chosen sessions by id (`sessions:read`, `sessions:write`).

**Confinement drops permissions.** An identity narrowed into an app keeps
only the app's refs; no project or control-plane permission survives, so an
untrusted bundle never inherits its viewer's powers.

**Clients** read effective permissions from `GET /me` (wildcards and
implications expanded). The desktop's remote "builder" experience (Git
checkout, program files) is `program:write`; approving proposals is
`program:publish`. Project-authored `when` predicates take `permissions`
only.

Alternatives considered: a single `program:write` covering publish (loses
the reviewer who may edit but not ship); keeping `manage` beside read/write
(two shapes for one idea); letting project automations inherit the enabler's
permissions (ties shared automation to one person's role).

## Consequences

- Deleting a project is a tenant-level operation for the root identity.
- Plugins routes, git operations, trigger listing and type sync, and GitHub
  push now check permissions; several previously checked only the tenant.
- Hosts binding identities through `forUser` pass `projectPermissions`
  alongside `scope`.
- Old role files with `builder` fail validation with a readable error; the
  greenfield migration is to rewrite them as grants.
