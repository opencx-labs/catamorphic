# Agent tool surface

Accepted in ADR 0133, following the September 2026 audit of desktop tools and
review apps. The default desktop projection has five fixed host registrations:
`discover_capabilities`, `invoke_capability`, `workspace_overview`, `open_surface`,
and `update_todo_list`. Harness-native execution and question adapters are
additional. Previously up to 57 fixed host registrations were offered, before
connectors, workflow tools, native tools and duplicate gateway mounts.

## Admission standard

1. Prefer an existing primitive. Ordinary source, configuration, inspection,
   component installation, compilation and tests use files, libraries or shell.
   Supply a skill with procedures and examples when needed.
2. Keep host-owned identity, secrets, assignment, sync, durable execution and
   live UI state in their owning service. Expose its operation through the one
   capability registry. Skills explain behavior; services enforce authority.
3. A default tool needs a demonstrated interaction benefit. Record its policy,
   schema/prompt cost and representative scenario results in the change. Update
   the eager inventory assertion only after agreeing to expand this surface.
4. Use the same implementation for internal discovery and public MCP. Do not
   copy business rules into a transport, invent a second registry, or mount a
   generic project MCP server back into an internal session.
5. Test discovery, execution, revocation and the user-visible result. Media must
   remain model media. Preserve cancellation, ownership, user takeover, and
   meaningful operation names in activity. Never make a skill an access check.

Descriptions are concise invocation contracts. Procedures belong in the
replaceable `desktop-workspace`, `building-apps`, `workflow-lifecycle`,
`session-artifacts`, and component-pack skills. Do not require cosmetic tool
calls on every conversation. Native shell remains available; native private
todos/delegation/monitors stay disabled when the host owns those functions.

## Inventory and disposition

Names below omit `workspace.` or `project.` prefixes for readability.
Availability also depends on identity, services, agent mode and topology.

| Operations | Projection and purpose |
|---|---|
| `workspace_overview`, `open_surface`, `update_todo_list` | Eager, bounded workspace context and visible handoff/progress |
| `list_project_sessions`, `read_project_session`, `send_project_session_message` | Deferred, authorized peer coordination; `children_only` filters the listing |
| `spawn_subsession`, `wait_for_subsessions`, `interrupt_subsession` | Deferred, host-owned child sessions and delivery |
| `request_user_attention`, `set_session_activity`, `read_todo_list` | Deferred, session state |
| `list_worktrees`, `create_worktree`, `use_worktree` | Deferred and native-only; `path: null` returns to primary. Git facts use shell; assignment uses the host |
| `read_tab`, `point_at`, `set_chat_icon` | Deferred, live selection and optional presentation; `target: null` clears highlighting |
| `open_browser`, `browser_snapshot`, `browser_act`, `surface_control` | Deferred, signed-in browser and user takeover |
| `run_terminal`, `read_terminal`, `write_terminal` | Deferred, visible persistent host PTYs; ordinary commands use native execution |
| `build_app` | Deferred, host preview by default; `publish: true` explicitly publishes |
| `sync_project`, `create_pull_request` | Deferred, managed checkout and linked-remote semantics |
| `request_connection`, `read_skill` | Deferred connection consent and one skill fallback for inaccessible files |
| `documents_storage`, `documents_list`, `documents_read`, `documents_search`, `documents_write`, `documents_delete`, `documents_history` | Deferred shared document/store services; ordinary checkout files use native tools |
| `publish_document`, `revoke_publication`, `list_publications`, `propose_change` | Deferred sharing and proposal state |
| `ask_agent` | Deferred project-agent entry, distinct from peer delivery; host routes control delegation |
| `create_watcher`, `list_watchers`, `stop_watcher`, `create_github_watcher` | Deferred durable workflows with session-owned lifetime |
| `session_artifact`, `set_app_presentation` | Deferred temporary artifacts and app metadata; title/icon can be supplied at creation |
| Project-defined workflow tools, `catamorphic_poll_run` | Deferred live deployed workflow bindings and continuation; identical execution service to public MCP |
| `components.read` | Existing deferred, installable component packs; composition and evidence remain code and skills |
| `context.read`, `environments.list`, `assignments.current` | Existing deferred framework context and allocation facts |
| Profile connector tools | Deferred per-service discovery through the authenticated host pool; no global roster fetch on an empty query |

Removed duplicate registrations: `list_subsessions` becomes
`list_project_sessions {children_only:true}`; `use_project_checkout` becomes
`use_worktree {path:null}`; `clear_pointers` becomes `point_at {target:null}`.
The internal project projection omits `list_skills`, `read_skill`, and
`send_agent_message`. Native skills/files and the workspace fallback/peer
delivery operation cover them. External project MCP consumers retain these
public contracts.

Explicit Environment Allocation connection bindings remain harness MCP servers:
they are a caller-selected, capability-granted roster, not the entire profile's
connector catalog. Installed connector plugin projections retain skills and
commands while stripping duplicate MCP declarations.

## Implementation and verification

`workspace-tools.ts` owns each workspace operation's effect, read-only eligibility,
native-only constraint and eager status. Missing policy fails construction.
`desktop-capabilities.ts` supplies live session-specific entries to core's single
registry. It reloads caller/agent policies; core fences Allocation and membership,
validates input, completes approval, then re-resolves authority before execution.
Discovery is bounded and cursor-based. It does not grant permission.

`project-capabilities.ts` projects the public project implementations. Workflow
inputs are passed unchanged; only host-owned session operations bind their owner
to the invoking session. Host media uses the explicit `agent-tool-result`
envelope (8 MiB); ordinary output stays bounded at 1 MiB. Gateway requests allow
6 MiB to preserve the existing temporary artifact authoring limit.

Inventory/unit tests cover the eager surface, preview default, schemas, media,
activity naming and live revocation. Scripted desktop workspace E2Es route through
discovery/invocation, and the review E2E creates its app through the same gateway.
Real-provider visual checks are still necessary: scripted success cannot prove
that a model finds the right skill or chooses the intended operation.
