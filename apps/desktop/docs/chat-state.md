# Chat state and embedding

`packages/react` owns reusable delivery orchestration. Core owns durable execution,
transcripts and the inbox. Desktop owns surfaces, focus, bubbles, file persistence
and native clipboard access. Registry components compose the hook and callbacks;
they must not import Electron or assume a desktop workspace.

## Three independent facts

- Delivery: local session creation and message acknowledgement. `isSending` ends
  when those operations settle; mutation-observer pending flags are not authority.
- Execution: the server execution record determines `isWorking` and agent activity.
- Connectivity: a failed status request means the client cannot confirm progress;
  it does not prove the agent stopped or is still working.

The delivery reducer scopes events to their initiating conversation. Switching
projects/sessions resets local state. Late results cannot adopt a session or modify
the new conversation. Adopting the hook's own lazily created id is the same chat.
Overlapping sends settle independently. Failed messages retain content, attachments
and the original idempotency key for Send again. Registry `ChatDeliveryRecovery`
provides the optional presentation; hosts may supply their own.

The server inbox is the only queue authority. Queue mutations are serialized and
bounded; errors remain visible, and failed edits do not discard the held message.
Retrying a failed execution is distinct from retrying delivery. Do not reconstruct
execution from a pending fetch or optimistic transcript entries.

## Composer and resource integration

Every paste/drop/picker operation yields a visible attachment or actionable error.
Files that cannot be passed as model media still reach the agent as paths. The
host persists pathless clipboard bytes under the current project. Preserve text,
caret insertion, selection pills, undo and draft contents while preparation runs.
Resource links use the [workspace opening contract](workspace-interactions.md).

## Attachment and response previews

Composer and sent-message pills use the same lazy preview and shared InspectorPortal.
File links in agent prose are compact pills; web links stay inline. Both expose
hover/focus cards and preserve the workspace opening modifiers. Escape, outside
interaction and background scrolling dismiss cards; pointer travel into a card
keeps it open. Native media controls never autoplay and stop on dismissal.

Desktop resolves file content on demand through `main/file-preview.ts`. Relative
references resolve against the owning chat's project. Images, audio and video are
limited to 16 MiB; text/code previews read at most 16 KiB. Markdown files
(`.md`, `.markdown`, or Markdown attachments) render as formatted Markdown with
GFM tables, lists and code blocks. Other text/code renders as plain text,
including HTML. PDF and office document thumbnails use the OS thumbnail provider
on macOS/Windows with a deadline and size limit. Missing, corrupt, oversized or
unsupported files keep their metadata and an explicit fallback. Inline document
temporary files are private and removed after preview generation. Preview bytes
are ephemeral and never added to chat history or agent input.

Web cards reuse local browser history titles and show the destination. Hovering
does not visit a site or fetch tracking images. Installable `resource-preview`
provides the shared content renderer and `ResourcePreview` is a host-neutral data
contract. The registry timeline's `renderLink` hook lets hosts supply their own
preview UI after URL sanitization; desktop filesystem access stays in desktop.

## Registry maintenance

Edit `packages/registry/src` first, then update installed consumers by adapting only
imports and deliberate host integration. The desktop copy lives in
`src/renderer/components/catamorphic`. Registry build emits the installable JSON;
source edits alone do not update that output. Build the React package first because
consumers resolve its declarations and implementation from `dist`.

`packages/registry/src/examples/embedding.tsx` is a typechecked host example.
Use hook tests for concurrency and scope changes, and native Electron tests for
paste, focus, link hit targets and surface identity. Neither substitutes for the other.

Queue mutations resolve to `true` only after server confirmation. A `false` result keeps the shared queue editor and its draft open; host callbacks must preserve that outcome.

## Agent questions

Question batches are durable session requests with a `blocking` flag (default true).
Use `useAnswerAgentQuestion` and the request id to submit an answer. Non-blocking
questions stay answerable while work continues and after the turn finishes.
Collapsing a question preserves its draft. The existing inbox delivers answers to
the current harness or starts a continuation if the turn has already ended.
See ADR 0122 and the question schemas in `@catamorphic/sandbox`.

## Consent belongs to the conversation

Session tool approvals and native app-access consent are durable blocking agent
questions, with concise action, reason and explicit allow/deny choices. Do not
surface them as global alert dialogs or store their only copy in a mounted tab.
Navigation, minimizing, project switching and renderer reload must preserve the
request and its waiting indicator. Answer delivery is keyed to its initiating
session and request. Only an exact allow response grants access; ambiguous answers,
cancellation and late responses do not. Remembered app access is limited to the
same native session, app and risk level.

Withdraw a pending blocking request when its native call ends or is interrupted.
Do not leave an unanswerable prompt or a spinning tab. Read-only capability
discovery through host-authorized, session-scoped MCP endpoints needs no duplicate
native consent. External tool policies and service authorization still apply.
Connector forms and sign-in requests retain their typed elicitation contract.

Model and reasoning controls share the same inspector in floating and tabbed
chats. Before first send, store overrides on the draft and pass them into lazy
session creation. Do not mutate agent defaults from a conversation picker.
Existing sessions keep their overrides in core. Busy and unsupported controls
carry an explicit disabled reason; close the inspector when opening the picker.

Markdown link components must keep stable React identity when chat state or host
callbacks change. Pass fresh callbacks through context; do not define a new
anchor component inside each render. Replacing anchors drops keyboard focus and
closes resource previews even when the visible reply has not changed. Keep the
registry source and installed desktop/PWA copies aligned.


### Unified resource inspection

Use `ResourceInspector` for hover/focus behavior and `InspectorPortal` for every
rich preview's shell, positioning, motion and dismissal. Composer attachments,
surface chips (including expanded group members), response links and sidebar
previews use these primitives. Do not add per-surface hover timers or standalone
preview modals. A preview opens on keyboard focus, stays open while the pointer
moves into it, and dismisses on Escape without opening the resource.

Use the installable `ResourcePreviewContent` for bounded file/Markdown/media and
resource summaries. Keep Markdown's default URL sanitization and raw HTML disabled;
embedded images and links in previews are inert so hovering never navigates or
loads remote content. Preserve filenames, locations, truncation and retry states.
Surface chips carry host-resolved file paths/URLs when available, so they preview
the same content as a response link to that resource. Terminal previews read a
bounded recent-output snapshot through the existing terminal buffer API and the
shared terminal-text sanitizer. Workflow and app previews use catalog metadata;
hovering never executes a workflow or mounts an app.

Crowded surface groups use the plural type as the label: Terminals, Apps,
Workflows, Files, Pages, Chats, Subagents, Watchers, or App views. Show the count
separately. Clicking the group discloses every member; each member retains its
preview and normal open/remove actions. Never label a group with one member's
name or silently hide members behind a count.

Agent-created terminal chips use the command as their initial name so grouped
terminals stay distinguishable. Response links to known workspace surfaces use
the same preview data as their composer chips; browser tab attachments use the
shared page preview. Keep opening behavior separate from inspection.

Native session ownership conflicts must explain which client to close and retain
manual retry. Do not automatically fork history, steal a writer lock, or present
this as an authentication failure. Local-auth Codex sessions can also be opened
by the Codex desktop app, which then owns the native writer lock.
