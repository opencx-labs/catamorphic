/** Current host-tier mechanics, also available to projects with older seeded skills. */
export const WORKFLOW_LIFECYCLE_SKILL = `---
name: workflow-lifecycle
description: Choose where Catamorphic workflow source belongs and how it is saved, shared, deployed, and enabled. Use before creating a workflow, session watcher, reusable personal automation, or publishing an existing workflow.
---

# Workflow lifetime, files, and sharing

Read the project's instructions and existing workflow layout first. A workflow
is ordinary exported TypeScript, never a JSON recipe or a second monitor DSL.
Choose lifetime, source visibility, and execution placement separately. A git
commit does not by itself mean shared, deployed, enabled, or permanent.

## Choose the outcome before writing files

| User intent | Source and lifetime | Execution |
| --- | --- | --- |
| "Watch this until the task is done" or a temporary reminder/check | Pass source directly to the available create_watcher or create_github_watcher tool. The host writes an isolated expiring revision; do not add a file to the user's working tree. | Ordinary workflow run in an allowed Environment, owned by this session. |
| "Run this for me every morning" using a reviewed project workflow | Reuse the project's committed source and create the user's own enablement through the host's supported consent flow. Personal execution does not make the source private. | Exact deployment, that member's authorized connections, declared triggers, explicit Environment. |
| "Save this workflow privately for my own use" | Use only a host-supported private artifact capability. A project directory, unpushed branch, incognito chat, or session watcher is not private storage. | Follow the host's private execution support; do not substitute a shared deployment. |
| "Add a reusable workflow to this project" | Work in workflows/src/<descriptive-name>.ts, following the existing layout. Project code is checkpointed and may sync automatically. | Validate first; deployment and unattended enablement are separate actions. |

Private workflow support is host-provided. The reserved local-only path is
.catamorphic/personal/<profile-id>/workflows/, but a directory alone does not
make a runnable personal workflow. Do not invent a profile id, private runner,
remote personal endpoint, or claim that saving there makes it appear in the
workflow UI. Explain the missing capability when a user requests it. Embedders
may supply their own private artifact and execution tools; use those when offered.

## Temporary source belongs to the watcher tool

Use create_watcher for ordinary periodic checks with an inline schedule trigger.
Use create_github_watcher for the supported GitHub Project Events when offered;
it establishes the host's event monitor. A Monitor observes and emits events;
the workflow contains the condition and actions. Do not create another daemon,
cron job, native harness monitor, or indefinitely running shell loop.

- workflowName must equal the exported defineWorkflow name in source. Choose a
  name that does not collide with an existing project workflow.
- Pass the source string directly. The host creates
  workflows/src/watchers/<watcher-id>.ts on catamorphic/watchers/<watcher-id> in
  an isolated checkout of the committed project origin. You do not need to
  create a worktree, commit, push, or scaffold the user's project for a watcher.
- That snapshot does not contain this session's uncommitted or unshared helper
  files. Keep temporary source self-contained, or import only dependencies and
  modules already present in the committed origin. Relative imports resolve
  from workflows/src/watchers/, not from the user's current directory.
- Use registered trigger kinds and their actual config/payload types. For a
  schedule, the payload has bindingId, scheduledFor, and firedAt. For an event
  watcher it is the normalized Project Event envelope. Do not copy a fictional
  event kind from an example into a real request.
- Set a bounded expiry appropriate to the request and an allowed Environment.
  Local execution requires its machine/app to stay available; remote execution
  requires its server. Remote placement does not change the session owner.
- Keep quiet on unchanged or non-actionable state unless the user requested
  progress reports. Bound network calls, use stable idempotency keys for
  duplicate events, and do not embed credentials in source or messages.
- A boundary may return context.host["catamorphic.sessions"].deliver(...).
  message_only appends without a model turn; next_turn wakes or queues a turn;
  interrupt is for genuinely urgent work. A terminal result does not itself
  stop a watcher. Have the owning agent call stop_watcher after the condition
  is satisfied; when it must react, deliver with next_turn and identify the
  watcher by its name. Expiry is the fallback, not the normal completion plan.
- Keep the returned watcher id. Confirm its status, Environment, expiry, and
  notification behavior. Reuse or stop an existing equivalent watcher rather
  than creating duplicates. Stop, expiry, and session close/archive disable
  future activations. Closing a chat tab alone does not close its session.

Temporary means expiring activation, not secret or instantly erased source.
Live runs retain their immutable revision until they settle; old git objects
may remain until garbage collection. Never put private source or secrets into
this ref as a workaround for unavailable private storage.

## Reusable project source

For a first project workflow, consult catamorphic-projects and install its
workspace support files if the project has no workflows workspace. Merge with
an existing package.json and scripts rather than overwriting them. Follow
writing-workflows for the complete authoring contract; use durable-workflows
for retries, pauses, host/connection calls, and child calls, and batch-workflows
for paged collections.

- Put exported definitions and related helpers under workflows/src/. Use the
  project's established SaaS wrapper, otherwise @catamorphic/workflow. Runtime
  dependencies belong in workflows/package.json. Shared app/workflow types
  belong in contracts/src/. Never import backend code into an app.
- The exported name is the workflow identity used by roles, triggers, runs,
  and links; the file name is its editable source location. Discover existing
  names before choosing or renaming one. Workflow discovery parses TypeScript;
  do not hand-register a graph or a parallel JSON workflow definition.
- Use defineWorkflow(({ defineBoundary, defineBatch }) => ({ steps: [...] })).
  Each boundary is one atomic retry scope. Put IO in ordinary async functions
  with one destructured parameter and a "use step" directive. Add UI metadata
  with @displayname, @description, and @param. More boundaries express retry
  and continuation semantics, not merely more boxes in the graph.
- Host calls, brokered connections, pause, and callWorkflow are boundary
  transitions: return them and consume their result in the next boundary.
  Do not await a transition as if it were a normal function result.
- Generated workflows/src/catamorphic-triggers.d.ts supplies trigger types.
  Do not edit it or invent kinds, account aliases, capabilities, or APIs.
- Export from workflows/src/app-api.ts only when an app should be permitted
  to call that workflow. Being a project workflow does not require app exposure.

## Saving, sharing, running, and enabling are different actions

1. Validate the actual files and imports with the project's bun run check.
   Check trigger config and input types, declared connection requirements,
   roles, and generated app contract when applicable. Inspect the rendered
   graph and relevant behavior when the host provides them. Do not run paid or
   externally mutating actions just to test code without task authorization.
2. Let the host checkpoint the work. The desktop checkpoints ordinary project
   files after each turn and linked projects can automatically sync. An
   uncommitted file or unpushed branch is not a privacy boundary. When review
   before sharing is required, select the host's isolated checkout/review flow
   before editing; do not first put the work on an automatically synced branch.
3. Share through the host's existing sync or pull-request tools when the task
   authorizes it. Preserve an already authorized publishing scope; ask only for
   a missing destination, visibility, or approval the host actually requires.
   Do not force-push, stage unrelated files, or publish credentials.
4. A durable Run uses an exact deployed commit. Editing, checkpointing, or
   pushing source alone does not prove that the running deployment changed.
   Use the offered deploy/run flow and verify the revision and result.
5. Triggers in code are inert without an enablement. For unattended use, the
   owner reviews the pinned revision, Environment, exact connections, actions,
   and triggers and explicitly enables it. Authentication alone is not consent
   to automation. Existing enablements do not silently upgrade on deployment.

To turn a successful temporary check into reusable project code, copy the
logic into the canonical project location only when the user wants to keep or
share it. Remove session ids, one-off targets, private assumptions, and expiry
coupling; parameterize what should be reusable, declare dependencies and
connections, validate, and use the normal review/deploy/enable flow. Stop the
old watcher when its replacement is active to avoid duplicate work.

Finish with concrete facts: the source path or watcher id, who can see it,
where it executes, whether it expires, and which of saved, shared, deployed,
and enabled actually succeeded. Link the workflow graph and its editable
source where the host supports links. Never report "running" merely because
code was written.
`;
