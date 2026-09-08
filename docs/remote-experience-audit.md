# Remote company-brain implementation

Date: 2026-09-07. Implementation rebased onto `origin/main` at `21a235f` after
reviewing PR 29 (merged workflow inspector) and open PR 30 (fonts only).
[ADR 0098](decisions/0098-project-authorized-local-and-remote-agents.md) and
[ADR 0099](decisions/0099-shared-postgres-server-environments.md) record the approved
model. This is an alpha cutover, with no compatibility layer for unsafe routing.

## Member journey

Invitations are credential-free. OAuth establishes identity and admission applies
current membership. Redeeming a consumed invitation cannot restore revoked access;
consumption and membership creation are atomic. Local password accounts remain
operator-provisioned; targeted email invitations still require verified email.
Use company SSO or assign an existing local user rather than weakening verification.

Remote desktop projects use the remote member API for agents, conversations,
workflows, connections, and approvals. Scoped caches belong to that connection's
authentication lifetime. The desktop's local administrator identity cannot grant
company access. PWA preserves credential-free invitation intent after auth errors.

The authority's agent catalog resolves committed definitions, filters permissions,
reports runtime availability, and resolves a usable project default. Both clients
select from that catalog and permitted Environments. Project roles grant execution
locations; agent definitions can narrow and prefer them. A stored Allocation governs
the actual provider and workspace. Offline, revoked, or rebound targets fail;
there is no silent fallback. Stock builtin definitions use the host's service model
when credentials are omitted; explicit personal credential definitions are rejected.

Members browse permitted deployed workflows without receiving unrelated project
files or drafts. Desktop and PWA share the connection-authentication and workflow
review components from `@catamorphic/ui`. Connecting an account returns to review;
it never implicitly enables a workflow. The consent summary shows account labels,
actions, triggers, revision, and execution target. Members can pause, reconnect,
and review deployment updates. Provider callbacks show a host-owned completion
page, and the original client observes completion through its authenticated status
endpoint.

## Execution and package boundaries

The stock Postgres host registers leased machines under one public authority.
Postgres stores origin objects, artifacts, encrypted credentials, approvals, and
execution coordination. Each worker claims only its admitted machine's work.
Cross-instance auth configuration is checked at boot. PGlite remains standalone.

Server-agent workspaces checkpoint to isolated shared session branches. Explicit
relocation restores those checkpoints and the transcript; unacknowledged work is
not silently replayed. A member's **This machine** is an authenticated SDK client,
never a trusted database-connected server. Its lease belongs to one connection
lifetime and its sandbox operations retain current member permissions.

Core owns policy, admission, execution state, and consent. The SDK owns reusable
Postgres storage and client execution. Stock owns auth and operator enrollment.
Desktop owns local sandboxes and remote transport. Generic object-store git
transport lives in `@catamorphic/git`, with S3 as a vendor adapter. No embedding
host must adopt Better Auth, Electron, or a stock-server singleton.

Desktop file browsing and editing use explicit local filesystem IPC, while
document synchronization checks remote membership. Scoped skill reads use the
shared committed version. Incognito tabs never mount remote conversations.

The stock host advertises controller agents. For **This machine**, commands/files
run locally while the model loop and credential broker remain on a managed server.
Native CLI relocation and offline models are not implied by this transport.

## Resource allocation and sandbox review

Updated from main `d906b28` after the theme and alpha.4 release merges; there were
no open PRs. Main's [latest CI run](https://github.com/opencx-labs/catamorphic/actions/runs/34143787062)
completed successfully during this review.

Managed allocations now reserve workspace slots and CPU/memory budgets atomically
in Postgres. Full nodes reject new allocations while admitted sessions remain
usable. Each allocation owns one sandbox; archive/close/move and terminal workflows
retire it, and confirmed destruction returns capacity. Cleanup does not block
heartbeat renewal. Failed or uncertain cleanup retains capacity for explicit
operator recovery. Archive/restore preserves the conversation and readmits it.

Capacity cleanup, operator recovery, and workflow claims use the host's injected
database schema. Regression tests run against a host-owned Postgres pool without
changing its search path, including atomic admission and the queue's 40,000-job
bounded-read check.

Agent resource requirements reach sandbox creation. Stock servers can select
microsandbox for per-agent CPU/memory limits; trusted local-process execution
rejects unsupported limits. Member runners advertise actual isolation and supported
limits. Native CLI paths cannot claim controller-sandbox limits. Disk and GPU
limits are not implemented by the stock providers and fail explicitly.

The review also fixed subprocess stop/timeout handling to kill command process
groups, corrected microsandbox idle-timeout units, and made VM deletion idempotent.
The live cached-image VM check observed one CPU and approximately 480 MiB usable
memory inside a 512 MiB VM, verified stop/start, and removed the sandbox afterward.
The model controller remains outside that VM, so machine budgets leave host headroom.

The merge gate also exposed an intermittent Markdown editor failure: API writes
could land in an internal working copy before the desktop persisted a new project's
chosen folder. `FsBackend` now keeps an explicitly initialized root addressable
through that registration interval. A regression failed before the fix and passed
afterward; the editor test exercises the normal end-to-end file path.

See [ADR 0100](decisions/0100-workspace-resource-admission.md) and the
[capacity setup and recovery reference](../skills/setup-catamorphic-server/references/cluster-deployment.md#capacity-and-isolated-development).

## Verification

Final resource and embedding follow-up on 2026-09-07: `bun run check` passed all
12 stages on the updated main base, including 395 core tests, 59 stock-server
tests, 351 desktop unit tests, 8 PWA E2E tests, 37 visible desktop E2E tests, and
144 hidden desktop E2E tests. The custom-schema pool tests and the deterministic
folder-registration regression are included. A live local microsandbox check
also verified CPU/memory limits and stop/start behavior.

Focused tests cover invite replay/rollback, actual two-provider placement, member
runner ownership and revocation, rejection of old leases after reconnect, encrypted
vault tampering, and session checkpoint movement without publishing project policy.
The shared-Postgres integration covers concurrent server boot, OAuth across instances,
custom committed agents, exact machine execution, shared object CAS/vault access,
durable approvals, and disabling a node.

Remote-experience validation before the resource follow-up on 2026-09-07: `bun run check` passed all 12 stages, including
lint, root and workspace type checks, builds, migration/codegen consistency,
workspace tests, 8 PWA E2E tests, 37 visible desktop E2E tests, and 142 hidden
desktop E2E tests. Updated skill metadata and local Markdown links validate.

The real desktop and stock-server development hosts were also inspected visually
using deterministic agents: invitation sign-in, the permitted project agent,
workflow graph and consent review, connecting This machine, completing a local
turn, and explicitly moving that session to the server and continuing its history.
That walkthrough caught and fixed Chromium's form Origin handling, shared CSS
source discovery, canvas overlap, and provider-specific client workspace roots.
Local file editing/sync/publication and incognito isolation have regression coverage.
No live external model or connection provider was exercised.
