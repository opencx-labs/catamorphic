# Agent tool surface

Accepted in ADR 0133, following the September 2026 audit of desktop tools and
review apps. The default desktop projection has fifteen fixed host registrations:
`discover_capabilities`, `invoke_capability`, `workspace_overview`, `read_tab`,
`open_surface`, `update_todo_list`, the three background-command tools
(`run_background_command`, `read_background_output`, `stop_background_command`,
ADR 0155), `watch_command` (ADR 0156), the browser's `open_browser`,
`browser_snapshot` and `browser_act`, and the subagent pair `spawn_subsession`
and `wait_for_subsessions` (ADR 0202). Harness-native execution and question
adapters are additional. Claude Code receives every host tool with
`_meta["anthropic/alwaysLoad"]`, so its own tool search never defers them.
Previously up to 57 fixed host registrations were offered, before connectors,
workflow tools, native tools and duplicate gateway mounts.

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
Availability also depends on identity, services, agent sandboxing and topology.

| Operations | Projection and purpose |
|---|---|
| `workspace_overview`, `read_tab`, `open_surface`, `update_todo_list` | Eager, bounded workspace context, reading what is on screen, and visible handoff/progress |
| `list_project_sessions`, `read_project_session`, `send_project_session_message` | Deferred, authorized peer coordination; `children_only` filters the listing |
| `spawn_subsession`, `wait_for_subsessions` | Eager, the agent's subagents: host-owned child sessions whose results steer into the parent's working turn (ADR 0202) |
| `interrupt_subsession` | Deferred, stops a direct child |
| `request_user_attention`, `set_session_activity`, `read_todo_list` | Deferred, session state |
| `list_worktrees`, `create_worktree`, `use_worktree` | Deferred and native-only; `path: null` returns to primary. Git facts use shell; assignment uses the host |
| `point_at`, `set_chat_icon` | Deferred, optional presentation; `target: null` clears highlighting |
| `desktop_settings` | Deferred, the owning profile's settings files, scopes and validation errors for the configuration skill |
| `open_browser`, `browser_snapshot`, `browser_act` | Eager, the signed-in browser: real input, uploads, downloads, and the page's console, network and JavaScript (ADR 0202) |
| `surface_control` | Deferred, release, reclaim or close a browser tab or terminal. A browser tab the agent drives goes back to the person by itself when the turn ends |
| `run_background_command`, `read_background_output`, `stop_background_command` | Eager, long-running processes in their own agent terminals; they outlive the turn and wake the chat when they finish (ADR 0155). Foreground commands use each harness's native shell |
| `watch_command` | Eager. A quick check re-run on an interval in the chat's working directory; wakes the chat once on success or on every output change. Durable across restarts, missed checks coalesce, `stop_background_command` ends it (ADR 0156) |
| `write_terminal` | Deferred, raw input to a terminal (prompts, REPLs, Ctrl+C, the person's own terminal on request) |
| `build_app` | Deferred, host preview by default; `publish: true` explicitly publishes |
| `sync_project`, `create_pull_request` | Deferred, managed checkout and linked-remote semantics |
| `request_connection`, `read_skill` | Deferred connection consent and one skill fallback for inaccessible files |
| `documents_storage`, `documents_list`, `documents_read`, `documents_search`, `documents_write`, `documents_delete`, `documents_history` | Deferred shared document/store services; ordinary checkout files use native tools |
| `publish_document`, `revoke_publication`, `list_publications`, `propose_change` | Deferred sharing and proposal state |
| `ask_agent` | Deferred project-agent entry, distinct from peer delivery; host routes control delegation |
| `create_watcher`, `list_watchers`, `stop_watcher` | Deferred durable workflows with session-owned lifetime; `eventSource: "github"` polls the project's repository as github webhook deliveries (ADR 0177) |
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

## read_tab joins the eager surface (ADR 0152)

Each turn's context already names the focused surface with a short look inside
it, but a real Claude Code run asked "What is this thing?" over a web page and
reached for a personal Chrome MCP (a different browser) because `read_tab` sat
behind discovery. Reading what the person sees is the most common workspace
question, so `read_tab` is eager. Its schema is one string parameter.

## Background commands join the eager surface (ADR 0155)

Before them, a long build or dev server either held a turn open or died with
Claude Code's per-turn process, Codex could only guess at daemonized commands,
and nothing told an agent when work finished. Every harness now starts such
work with `run_background_command` and is woken by a system message when it
ends or prints a watched line. The three schemas cost about 1.3 KB; the eager
budget is 7 KB.

## Command watches (ADR 0156)

Waiting on something outside the agent's own processes (a deploy, a review, a
file) used to mean a sleep loop that held the turn, or a workflow whose isolated
checkout could not see the person's files or localhost. `watch_command` runs a
check where the agent's commands run and wakes the chat like a background command.
Its schema costs about 1.3 KB; the eager budget rose to 8.3 KB.


## Seeing Work itself (ADR 0195)

A real Claude Code run asked the person what two sidebar sections showed:
discovery for "screenshot window capture sidebar" returned nothing, and no tool
could see Work's own window. `read_tab` now takes the key `window` and returns
a screenshot of the project's window as model media, with no new schema, and
discovery falls back to any word when no capability matches every word of a
descriptive query. The playbook and the desktop-workspace skill say to look
before asking. The question adapters gained `close_questions`, which withdraws
the agent's own open questions after a chat reply settled them.

## The browser and subagents join the eager surface (ADR 0202)

A Claude Code agent audited its own limits against twelve earlier chats. One
told the person Work's browser could only read and navigate, because discovery
for "browser terminal" required both words and returned the two capabilities
that mention them, not the browser's own tools; four failed `invoke_capability`
on `requestId` or on fields placed beside `input`. The delegation prompt named
`spawn_subsession`, a tool the agent could not see, so it concluded it had no
subagents. The five tools cost about 4.7 KB of schemas; the eager budget is
13.5 KB. Discovery now ranks by matched words with name matches counting double,
`requestId` is optional, and invalid input returns the capability's schema.

## The assistant and voice (ADR 0216)

The dock's assistant runs on `work-assistant:<agent id>` (Work's built-in
assistant: the person's default agent with no persona, at its harness's
default model) or `assistant:<agent id>` (an agent the person chose, as
configured), each with its base agent's full surface above. Six direct
tools (`main/server/assistant-tools.ts`) take the place of the
project-only session tools (`spawn_subsession`, `wait_for_subsessions`,
`interrupt_subsession`, `list_project_sessions`, `read_project_session`,
`send_project_session_message`): `start_session`, plus `list_sessions`,
`read_session`, `message_session`, `follow_session`, `answer_question` and
`stop_session`,
which reach the person's chats in every project of the profile, the ones
they started included, and never incognito ones. Its delegation routes
target the base agent (`work`) and any agent the person names (`named`).
Its host instructions describe the tools (`ASSISTANT_INSTRUCTIONS` in
`main/voice/guidance.ts`).

`start_session` takes the person's request in a sentence or two, and an
agent's name when they give one, and wraps the request in a brief
(`assistantTaskBrief`): the session reads the assistant's chat with
`read_project_session` for what was actually said, and reaches the person
by sending it a message with `send_project_session_message`, starting with
its title. The assistant follows the sessions it starts, and others with
`follow_session`: their notes (messages with more work after them in the
turn) reach it as one system message a few at a time, shown as one quiet
line, and a followed chat's result when its turn ends
(`main/server/session-notes.ts`). A question or approval a followed chat
waits on reaches it at once; `answer_question` answers a question with what
the person said, as the person, while approvals stay theirs to give in that
chat. `read_session` lists what a chat waits on. The assistant's chat is kept local like an
incognito chat, so it is never mirrored and no other chat reads it; its
playbook leaves out subsessions and the project-only chat tools, which it
neither has nor discovers. It messages a chat the person
created, and relays a session's question and the answer
(`e2e/voice-agent.e2e.ts`).

Any chat the person talks with by voice gets one context fragment per turn
(`VOICE_CONTEXT`, source `voice`): that they talk by voice, that messages
are read aloud as they finish, and that voice can end. It is information,
never rules, so the agent's own instructions decide how it talks.
