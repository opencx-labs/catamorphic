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

## Choose the intended result

| User intent | Source | Activation |
| --- | --- | --- |
| Remind me, wake this session, or watch until a condition is met | Pass TypeScript directly to \`create_watcher\` or \`create_github_watcher\`. The host retains an isolated revision with this session. | Session-owned, with no default expiry. See \`session-workflows\` for time, attention, and cancellation. |
| Save reusable automation for the project | Follow the existing layout, normally \`workflows/src/<name>.ts\`. | Deploy an immutable revision, then enable it for unattended execution. |
| Run a reviewed workflow for one member | Reuse committed project source. | A member-owned enablement uses that member's authorized connections and Environment. |
| Keep workflow source private | Use a private artifact capability only if this host provides one. | Follow that capability's execution support. An unpushed branch or incognito chat is not private source storage. |

Personal execution does not make source private. The desktop reserves
\`.catamorphic/personal/<profile-id>/workflows/\`, but private workflow discovery,
invocation, and schedules are not supplied by that directory. Do not fabricate
an id or claim that saving there creates a runnable private workflow.

## Session-owned source

- Pass the source string to the watcher tool, without first writing it into an
  automatically checkpointed project folder. \`workflowName\` must match the export.
- The host writes \`workflows/src/artifacts/<artifact-id>.ts\` on
  \`catamorphic/artifacts/<artifact-id>\` from the committed project origin.
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

For a project without a workflows workspace, use the copyable support files in
\`catamorphic-projects\`. Merge with existing package files instead of replacing
customizations. Put runtime dependencies in \`workflows/package.json\`, shared
app/workflow types in \`contracts/src/\`, and expose workflows through \`app-api.ts\`
only when apps need access. Follow the established wrapper package, otherwise
use \`@catamorphic/workflow\`; do not copy the runtime helpers into the project.

Declare provider-neutral aliases and actions in the workflow's \`connections\`.
Member roles separately grant the workflow export, each connection alias, the
Environment, and any project agent it wakes. Credentials and concrete connection
ids belong to the host's reviewed connection flow, never the source. Authentication
alone is not consent to enable every eligible workflow.

## Saving, sharing, deploying, and enabling

1. Validate source, imports, trigger payloads, and generated app contracts with
   the project's \`bun run check\`. Use the host's actual trigger schemas.
2. Account for desktop checkpoints and configured automatic sync before editing.
   If sharing requires review, choose an isolated review flow first. Neither
   uncommitted files nor an unpushed branch guarantees privacy.
3. Share through the authorized sync or PR flow. Preserve existing authorization;
   ask only for a missing destination or approval that the host actually requires.
4. Deploy through the host's offered flow and verify the revision. A saved file,
   git commit, or push alone does not update a deployment or an existing enablement.
5. Enable through the host's consent flow with the intended owner, Environment,
   connections, and triggers. In the desktop, the member uses **Automate** and
   **Enable for me**. Connecting an account may finish that initiated flow;
   connecting an account by itself never initiates it.

To keep a successful session check, copy its selected source into project code
when requested. Resolve name collisions, parameterize session-specific targets,
validate, deploy, and enable normally. Stop the old watcher when its replacement
is active to avoid duplicate work; do not merge the entire temporary ref.

Report the source or watcher link, owner, execution host/Environment, lifetime,
and which of saved, shared, deployed, or enabled actually succeeded. For reminders,
include the resolved date/time, offline delivery behavior, and archive cancellation
as described by \`session-workflows\`.
`;
