# Agent tool surface

Accepted in ADR 0133, following the September 2026 audit of desktop tools and
review apps. The default desktop projection has sixteen fixed host registrations:
`discover_capabilities`, `invoke_capability`, `workspace_overview`, `read_tab`,
`open_surface`, `update_todo_list`, the three background-command tools
(`run_background_command`, `read_background_output`, `stop_background_command`,
ADR 0155), `watch_command` (ADR 0156), the browser's `open_browser`,
`browser_snapshot` and `browser_act`, the subagent pair `spawn_subsession`
and `wait_for_subsessions` (ADR 0202), and voice's `stop_listening` (ADR
0224). Harness-native execution and question adapters are additional.
Claude Code receives every host tool with `_meta["anthropic/alwaysLoad"]`,
so its own tool search never defers them.
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
| `list_project_sessions`, `read_project_session`, `send_project_session_message` | Deferred, authorized peer coordination; `children_only` filters the listing; a message steers by default (read at the other agent's next step, or a turn when it is idle), and a subagent's to its parent always does (ADR 0250) |
| `spawn_subsession`, `wait_for_subsessions` | Eager, the agent's subagents: host-owned child sessions whose results steer into the parent's working turn (ADR 0202). A copy of the agent unless `agent` names another, on the `model` and `effort` its grants allow; `read_only` (where the harness has a read-only mode) and `delegate: false` need no grant (ADR 0270) |
| `interrupt_subsession` | Deferred, stops a direct child |
| `request_user_attention`, `set_session_activity`, `set_session_metadata`, `read_todo_list` | Deferred, session state; `set_session_metadata` sets one named value the sidebar reads (ADR 0226) |
| `list_worktrees`, `create_worktree`, `use_worktree` | Deferred and native-only; `path: null` returns to primary. Git facts use shell; assignment uses the host |
| `point_at`, `set_chat_icon` | Deferred, optional presentation; `target: null` clears highlighting |
| `desktop_settings` | Deferred, the owning profile's settings files, scopes and validation errors for the configuration skill |
| `open_browser`, `browser_snapshot`, `browser_act` | Eager, the signed-in browser: real input, uploads, downloads, and the page's console, network and JavaScript (ADR 0202); a page's dialogs are reported and answered with `press` and `fill`, never a sign-in (ADR 0227) |
| `surface_control` | Deferred, release, reclaim or close a browser tab or terminal. A browser tab the agent drives goes back to the person by itself when the turn ends |
| `run_background_command`, `read_background_output`, `stop_background_command` | Eager, long-running processes in their own agent terminals; they outlive the turn and wake the chat when they finish (ADR 0155). Foreground commands use each harness's native shell |
| `watch_command` | Eager. A quick check re-run on an interval in the chat's working directory; wakes the chat once on success or on every output change. Durable across restarts, missed checks coalesce, `read_background_output` reads its latest check, `stop_background_command` ends it (ADR 0156) |
| `stop_listening` | Eager. Turns voice off in this chat once the turn's replies are read aloud; the microphone closes at once. Says what it does, never when (ADR 0224) |
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
| `registry.read` | Existing deferred, installable packs (UI components and project recipes, ADR 0262); composition and evidence remain code and skills |
| `context.read`, `environments.list`, `assignments.current` | Existing deferred framework context and allocation facts |
| Profile connector tools | A harness with tool search (Claude Code, Codex) gets each connector as its own MCP server, served from the authenticated host pool and loaded on demand (ADR 0225). The built-in agent discovers them per service through the catalog; no global roster fetch on an empty query |

Removed duplicate registrations: `list_subsessions` becomes
`list_project_sessions {children_only:true}`; `use_project_checkout` becomes
`use_worktree {path:null}`; `clear_pointers` becomes `point_at {target:null}`.
The internal project projection omits `list_skills`, `read_skill`, and
`send_agent_message`. Native skills/files and the workspace fallback/peer
delivery operation cover them. External project MCP consumers retain these
public contracts.

Explicit Environment Allocation connection bindings remain harness MCP servers:
a caller-selected, capability-granted roster (`connection_<alias>`). A harness
with tool search also gets each of the agent's profile connectors as its own MCP
server, served from the host pool by `connector-mcp.ts`; the built-in agent
reaches them through the catalog. Both kinds of server list tools and return
results as the connector declared and sent them (ADR 0225). Installed connector
plugin projections retain skills and commands while stripping duplicate MCP
declarations.

## Implementation and verification

`workspace-tools.ts` owns each workspace operation's effect, read-only eligibility,
native-only constraint and eager status. Missing policy fails construction.
`desktop-capabilities.ts` supplies live session-specific entries to core's single
registry. It reloads caller/agent policies; core fences Allocation and membership,
validates input, completes approval, then re-resolves authority before execution.
Discovery is bounded and cursor-based. It does not grant permission.
`connector-mcp.ts` serves mounted connectors: it lists only the tools the
agent's layers permit and decides each call with the same gate and approval
request as the catalog, so no harness permission mode skips an ask.

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
work with `run_background_command` and hears, as a task notification (ADR
0217), when it ends or prints a watched line it has not reported lately: in
the turn while it works, else in the one turn that waits for notifications. The three schemas cost about 1.3 KB; the eager
budget is 7 KB.

## Command watches (ADR 0156)

Waiting on something outside the agent's own processes (a deploy, a review, a
file) used to mean a sleep loop that held the turn, or a workflow whose isolated
checkout could not see the person's files or localhost. `watch_command` runs a
check where the agent's commands run and wakes the chat like a background command.
Its schema costs about 1.3 KB; the eager budget rose to 8.3 KB.

## A wait ends when something reaches the agent (ADR 0264)

A notification or message steered into a turn is read at the harness's next
step, which a waiting tool holds back. Every host tool call therefore gets
`stopWaiting`, fired when the engine hands the harness a steer, interrupt or
stop. `read_background_output`, `wait_for_subsessions` and the browser's
`downloads` and `wait_for` wait with `waitUntil` and return early, and core
adds one note to the result saying why.


## Agents' shells read patterns as bash does

Agents write bash: an unquoted `grep -r --include=*.ts` failed in zsh with
"no matches found" before grep ran, and an aborted search read to the agent
as a search that found nothing (488 commands in 117 of 152 chats over four
days). Agent shells set zsh's `no_nomatch` (and turn off the null glob
options, which would drop the pattern), so a pattern that matches nothing
stays as written:

- agent terminals, after the person's `.zshrc`;
- Claude Code, ahead of each command through `CLAUDE_ENV_FILE`, a read-only
  file every chat shares (a file the person set there still runs first);
- Work's own agent and watch checks, with each command.

Codex runs commands in its own shell and is not covered. The person's own
terminals and shell config are untouched.

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

## Subagents on the model the work needs (ADR 0270)

`spawn_subsession` took a route id, and its prompt listed routes as
`same-agent: <agent id>`, so agents passed the agent id: 38 of 67 spawns over
four days were refused. The tool now names an agent (none: a copy of yourself)
and the child's `model`, `effort`, `read_only` and `delegate`. Grants in the
agent's `delegation.agents` decide what it may set (a grant naming the agent
decides before `*`), the agent's harness catalog decides what exists, and
refusals list the choices. A copy starts on the parent chat's model and effort
as a pair. A read-only chat runs in its harness's read-only mode, keeps only
the host tools marked `readOnly`, and is `contained` for capabilities,
connections and connectors. The new fields raised the eager budget to 14 KB.

## The assistant and voice (ADR 0216)

The dock's assistant runs on `work-assistant:<agent id>` (Work's built-in
assistant: the person's default agent with no persona, at its harness's
default model) or `assistant:<agent id>` (an agent the person chose, as
configured), each with its base agent's full surface above. Six direct
tools (`main/server/assistant-tools.ts`) take the place of the
project-only session tools (`list_project_sessions`, `read_project_session`,
`send_project_session_message`, `interrupt_subsession`,
`wait_for_subsessions`): `list_sessions`, `read_session`, `message_session`,
`follow_session`, `answer_question` and `stop_session`,
which reach the person's chats in every project of the profile, the ones
they started included, and never incognito ones. It never waits on a
session: the person may be talking.
Its host instructions describe the tools (`ASSISTANT_INSTRUCTIONS` in
`main/voice/guidance.ts`).

It starts sessions with `spawn_subsession`, like any agent (ADR 0270). Its
copies run as its base agent (`copiesAs`), without its tools, on the
assistant chat's model and effort; its grants admit them and any agent the
person names, on any model and effort, so a quick assistant hands hard work
to a stronger model. Named by any agent, the assistant starts as its base
agent too, never a second assistant. Its `spawn_subsession` is Work's, wrapped
(`assistantWorkspaceTools` in `main/server/assistant-agent.ts`): it puts the
task in a brief (`assistantSubsession`), and follows the session. The session
reads the assistant's chat with `read_project_session` for what was
actually said, and reaches the person by sending it a message with
`send_project_session_message`, starting with its title (the task's first
words when it has none); a read-only session says everything in its result. The assistant follows the sessions it starts, and others with
`follow_session`: their notes (messages with more work after them in the
turn) reach it as one task notification a few at a time, shown as one row
that opens to the notes and links to that chat, and a followed chat's result
when its turn ends
(`main/server/session-notes.ts`). A question or approval a followed chat
waits on reaches it at once; `answer_question` answers a question with what
the person said, as the person, while approvals stay theirs to give in that
chat. `read_session` lists what a chat waits on. The assistant's chat is kept local like an
incognito chat, so it is never mirrored and no other chat reads it; its
playbook leaves out the project-only chat tools, which it neither has nor
discovers. It messages a chat the person
created, and relays a session's question and the answer
(`e2e/voice-agent.e2e.ts`).

Any chat the person talks with by voice gets one context fragment per turn
(`VOICE_CONTEXT`, source `voice`): that they talk by voice, that messages
are read aloud as they finish, and that voice can end. It is information,
never rules, so the agent's own instructions decide how it talks.

`stop_listening` ends a voice conversation from the agent's side (ADR 0224):
the microphone closes at once, the turn's replies are still read aloud, and
then voice turns off. Its description says what it does and never when, so
the person teaches their agents when to call it.

## Session metadata (ADR 0226)

A chat's details beside it (its pull requests, or any key a person's own
sidebar section reads) had no home: `create_pull_request` stored nothing and
pull requests opened with `gh` or a connector left no trace. One operation
sets one key of the session's metadata, `set_session_metadata { key, value }`
(`remove: true` removes the key and neither reads the metadata, since a key's
value is replaced whole; a null value is refused, so a model filling unused
parameters with null never deletes), on every harness through the session coordination bridge to
core. Its description and input are one shared contract
(`@catamorphic/agent-protocol`). It is deferred: a chat writes it a few times, when something
worth showing happens, so it costs no schema on ordinary turns (about 1.1 KB
in a discovery result). The project MCP surface offers the same operation to
members' own agents, only on a session's own connection and bound to it, and the Work server's
agents discover it; the desktop's internal projection leaves that copy out.
Nothing records metadata by itself: the desktop-workspace skill and the
pull request skills say, in a sentence, to keep `pull_requests`. Scenario
coverage: the fake agent's `record pr:` turn calls it through discovery and
`e2e/session-sidebar.e2e.ts` sees the row arrive and change state live.
