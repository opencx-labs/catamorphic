/** Agent guidance; shipped through the existing skill discovery surfaces. */
export const WORKFLOW_LIFECYCLE_SKILL = `---
name: workflow-lifecycle
description: Choose source location, ownership, execution placement, and the save/deploy/enable flow for a Catamorphic workflow or session watcher.
---

# Workflow lifetime and placement

Use this skill before choosing where a new workflow belongs, or when changing
its ownership or publishing it. Use \`writing-workflows\` for TypeScript mechanics
and \`session-workflows\` for reminders, monitoring, and session actions. Discover
the host's actual capabilities and schemas; a skill does not enable a missing tool.

## Compose existing primitives

A missing native integration or ready-made pack is not a blocker by itself.
Workflows run ordinary TypeScript with real npm packages and IO. Writing glue
code is normal: compose events/webhooks, retry boundaries, durable waits,
child workflows, external storage, and the host's authorized operations.
Inspect the installed APIs before claiming a missing product feature.

For example, a review service can use workflows to launch and stop AWS EC2
machines, a Postgres ledger for jobs and external receipts, and a custom Work
server for credentialed SDK calls and authenticated callbacks. An external
runner need not enroll as a Work worker. Use enrolled workers when it needs
Work's sandbox dispatch and agent-session lifecycle. A shipped cloud adapter
or review recipe is a convenience, not the limit of what can be built.

Keep business orchestration in project workflows. Put privileged operations,
authorization, credentials, and incoming routes in the host's code. With
\`@catamorphic/work-server\`, use \`hooks.connectionProviders\` for brokered
services, \`hooks.capabilityProviders\` for workflow host calls, and
\`hooks.routes\` for callbacks; read the setup-work-server skill in its
repository for the installed contracts. An existing application can mount the
lower-level SDK directly. External Postgres may hold application-owned state
in its own schema or database; do not write Work's internal tables.

Before calling something a blocker, name the missing guarantee, show a failing
case, and check whether existing code-level extension points supply it. Distinguish
a core defect from ordinary application work or a deployment acceptance test.
Use \`durable-workflows\` for retry, cancellation and external-effect limits.

## Choose the intended result

| User intent | Source | Activation |
| --- | --- | --- |
| Tell me when a command's result changes or succeeds (a URL, a file, a CLI) | Use the host's \`watch_command\` when offered: it runs the check where your commands run. | Owned by this chat; ends on success, stop, expiry or archive. |
| Remind me, follow up in this chat, or watch Project Events | Pass TypeScript directly to \`create_watcher\` (with \`eventSource\` for a host-polled source such as GitHub on the desktop). The host retains an isolated revision with this session. | Session-owned, with no default expiry. See \`session-workflows\` for time, attention, and cancellation. |
| Save reusable automation for the project | Use \`.work/workflows/src/<name>.ts\`. | Deploy an immutable revision, then enable it for unattended execution. |
| Run a reviewed workflow for one member | Reuse committed project source. | A member-owned enablement uses that member's authorized connections and Environment. |
| Run it for the whole project (webhooks, PR reviews, shared inboxes) | Reuse committed project source. | A project enablement, turned on by someone with \`automations:write\`, runs as the project with shared connections and the permissions consented to. Its chats are project chats. |
| Keep a private workflow independent of its creating chat | Discover \`private.workflow\`. It retains self-contained TypeScript and explicit files in a member-owned immutable artifact outside project files and Git. | Create saves source; run invokes once; preview and activate enable its ordinary triggers. Stop disables activation and cancels its active runs. |

Personal execution alone does not make project source private. Member-owned
private artifacts use the ordinary workflow engine, scheduler, Environment and
connection checks, with lifetime independent of a chat. Updates compare the
artifact revision; an active workflow retains its old source pin until explicit
activation of the new revision. Private source is self-contained: project files
and uncommitted helpers are not implicitly captured. Private artifacts and state
stay on the hosting authority; linking a server does not upload them.

## Private state and direct notifications

\`private.state.read({ key })\` returns this member's JSON value and version.
\`private.state.write({ key, value, ifVersion })\` uses the read version, or 0
for new state. A stale write returns a conflict. Deletion preserves the version.
State uses the existing versioned document journal in a member partition; it is
outside project files and ordinary project sync. Access requires
\`private-state:read\` or \`private-state:write\`.

Workflows return \`host["catamorphic.privateState"].read/write/delete(...)\` or
\`host["catamorphic.notifications"].publish({ title, body?, idempotencyKey })\`
from a boundary. Notifications are durable host operations and need no model
turn. Declare \`notifications:write\` for notification calls; retries deduplicate
by the supplied key. Delivery uses the host's configured native or push transport.

## Session-owned source

- Pass the source string to the watcher tool, without first writing it into an
  automatically checkpointed project folder. \`workflowName\` must match the export.
- The host writes \`.work/workflows/src/artifacts/<artifact-id>.ts\` on
  \`work/artifacts/<artifact-id>\` from the committed project origin.
  Imports resolve there, not against this session's uncommitted helper files.
  Keep the source self-contained or use dependencies already committed in origin.
- Session-owned watchers run on the session's authoritative host and Environment.
  A local reminder stays local when the desktop stops. Do not choose remote
  placement as an implicit fallback. Reusable project enablements may have a
  separately chosen execution Environment.
- Temporary means session-owned. Omit expiry for reminders unless the user asks
  for a separate expiration deadline. Closing a tab or finishing a turn leaves
  the watcher enabled. Closing or archiving its session stops future activation;
  archive also cancels paused watchers and those of subsessions. Restore does
  not restart them. Source and run evidence remain available with the session.
- Keep the watcher id and inspect its status. Reuse an equivalent watcher or stop
  it before replacing it. Source edits do not upgrade a pinned activation; stop
  and recreate it to use the changed revision. A workflow's ordinary return does
  not stop recurring triggers; return the \`stop\` host transition after the
  matching action when the monitor is finished.

A session artifact with kind \`workflow\` retains source and can run once through
its \`run\` action. Creating the artifact alone does not enable its triggers.
Use \`session-artifacts\` when this distinction matters. Temporary source is not a
privacy boundary; discarding it prevents new use without erasing retained runs.

## Reusable project code and access

For a project without a \`.work/\` workspace, use the copyable support files in
\`work-projects\` to create it. Preserve existing manifests
inside that workspace; leave the imported repository's root manifests unchanged.
Put runtime dependencies in \`.work/workflows/package.json\`, shared
app/workflow types in \`.work/contracts/src/\`, and expose workflows through \`app-api.ts\`
only when apps need access. Follow the established wrapper package, otherwise
use \`@catamorphic/workflow\`; do not copy the runtime helpers into the project.

Declare provider-neutral aliases and actions in the workflow's \`connections\`.
Member roles separately grant the workflow export, each connection alias, the
Environment, and any project agent it wakes. Credentials and concrete connection
ids belong to the host's reviewed connection flow, never the source. Authentication
alone is not consent to enable every eligible workflow.

Declare the project permissions its runs need in \`permissions\` (for example
\`sessions:write\`). A run holds nothing else, whoever started it. Only someone
who holds every declared permission can turn the workflow on; a member's
automation pauses when its member loses one, and a project automation keeps
what was consented to.

The enablement's Environment places the workflow's runs, nothing else. A chat
a workflow delivers to is placed by its own Environment: the \`environment\`
the delivery names, else the agent's preferred Environment, else the project
default. The chat's owner must be allowed that Environment (a member through
their roles; a project chat may use any project Environment) and the agent's
\`environment.allowed\` must include it.

## Saving, sharing, deploying, and enabling

1. Validate source, imports, trigger payloads, and generated app contracts with
   \`bun run --cwd .work check\`. Use the host's actual trigger schemas.
2. Account for desktop checkpoints and configured automatic sync before editing.
   If sharing requires review, choose an isolated review flow first. Neither
   uncommitted files nor an unpushed branch guarantees privacy.
3. Share through the authorized sync or PR flow. Preserve existing authorization;
   ask only for a missing destination or approval that the host actually requires.
4. Deploy through the host's offered flow and verify the revision. A saved file,
   git commit, or push alone does not publish. Publishing does update following
   enablements (see below); merging to the code host's \`main\` publishes a
   project attached to it.
   In the desktop, the workflow's **Automatic** view offers **Publish** first
   when the workflow is not published yet; say so rather than claiming it is
   deployed.
5. Enable through the host's consent flow with the intended owner, Environment,
   connections, and triggers. In the desktop, the member opens the workflow's
   status, chooses **Automatic** (shown when the code declares triggers), and
   **Enable for me**; someone with \`automations:write\` can choose **The project**
   instead. The consent lists the declared permissions. Connecting an account may finish that initiated flow; connecting an
   account by itself never initiates it.

## Following main, and the deploy workflow

A project automation of \`main\` follows the published program by default
(\`follow: true\`; set it when enabling, change it later with the enablement's
\`follow\` action). A member's own automation does not follow unless the member
turns it on, because it runs with their connections and they should see new
code before it uses them. On each newly published revision, Work moves a
following enablement there when the workflow builds and parses at that revision
and the authority consented to is unchanged: same Environment, connections,
capabilities and permissions, the same triggers (kind, configuration and
filters) and the same declared secret names. If the revision asks for more, the enablement
stays on its commit, shows an update, and its owner is notified to review it. A
revision whose workflow does not parse, is gone, or whose triggers do not
register is skipped and reported; the next good one is followed. A failure that
may clear (the database, the network, capacity) is tried again later, never
skipped. Runs already going keep the commit they started on. Temporary
enablements never follow. Turn \`follow\` off to pin a workflow to a reviewed
commit.

A project that keeps its own data (a database reached through a secret) names a
deploy workflow in \`.work/project.json\`:

\`\`\`json
{ "deploy": { "workflow": "migrateDatabase" } }
\`\`\`

Before following enablements move to a revision, Work runs that exported workflow
once at the new revision with \`{ commit, previousCommit }\` and waits for it.
It runs through its own project automation, so turn it on for **The project**
with the connections and secrets it needs. If it fails, nothing moves, the
previous revision stays live, the people who manage project automations are told,
and the next published revision runs its own deploy. Someone with
\`automations:write\` can also try the failed revision again (the project's
\`published-revisions/retry\`), and Work tries it once more by itself when the
deploy workflow's project automation is consented to again. One deploy runs per project at
a time, in publication order. What it does is up to the project: run migrations
with any tool, or nothing.

Write migrations expand then contract: runs on the previous commit keep running
against the new schema while they finish, including long pauses. A revision adds
columns, tables and defaults the new code needs without breaking the old code; a
later revision, once nothing reads them, removes what is no longer used. Make
each migration idempotent, since a failed deploy is tried again at the next
revision.

To keep a successful session check, copy its selected source into project code
when requested. Resolve name collisions, parameterize session-specific targets,
validate, deploy, and enable normally. Stop the old watcher when its replacement
is active to avoid duplicate work; do not merge the entire temporary ref.

## Telling the person

Report in the person's terms: what the automation does, when it runs, where they
can see it (a workflow or app link), and which of saved, shared, deployed or
switched on actually succeeded. For a reminder, give the resolved date and time,
and say that it arrives late if this computer is off and stops if the chat is
archived (see \`session-workflows\`). Add the source link, owner, execution
Environment and lifetime when the person is technical or asks. Never mention
watcher ids, artifact refs, temporary source files or internal folders to a
non-technical person.
`;
