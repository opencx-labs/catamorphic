# Chat state and embedding

`packages/react` owns reusable delivery orchestration. Core owns durable execution,
the session event log and the turn queue (ADR 0197). Desktop owns surfaces, focus, bubbles, file persistence
and native clipboard access. Registry components compose the hook and callbacks;
they must not import Electron or assume a desktop workspace.

## Three independent facts

- Delivery: local session creation and command receipts. `isSending` ends when
  those operations settle; mutation-observer pending flags are not authority.
- Execution: the session's turns determine `isWorking` (a turn preparing,
  running, waiting or finalizing) and the activity line (`turn.activity`).
- Connectivity: a dropped event stream means the client cannot confirm
  progress; it resumes from its last applied sequence and does not prove the
  agent stopped or is still working.

The delivery reducer scopes events to their initiating conversation. Switching
projects/sessions resets local state. Late results cannot adopt a session or modify
the new conversation. Adopting the hook's own lazily created id is the same chat.
Overlapping sends settle independently. A sent message shows at once and is
replaced by its item when the stream delivers it. Failed messages retain content,
attachments and their `commandId` for Send again, so a resend cannot deliver
twice; timelines show them as unsent bubbles with Send again and Dismiss.

A message sent while the agent works steers into its turn (ADR 0240): it
shows in the conversation at once, unread (`in_progress`) until the agent
takes it in at its next step, and its Interrupt (`steer_now`) has the agent
stop that step and read it now. The profile's "Queue messages sent while the
agent works" (`chatQueueMessages`, off by default) sends `queue` instead, and
⌘↵ sends `interrupt` either way.

The server's turn queue is the only queue authority. Queue commands
(`edit_queued`, `cancel_queued`, `send_now`) carry their own command ids; a
refused command shows its receipt's message, and failed edits do not discard
the held message.
Retrying a failed execution is distinct from retrying delivery. Do not reconstruct
execution from a pending fetch or optimistic transcript entries.

## Who wrote an input

Only a person's message is a `user_message` (ADR 0217). Another agent's,
the person's assistant's and a workflow's words are `inbound_message` items
with a `from`; Work's reports on tasks an agent started (background
commands, watches, subsessions, followed chats) are `task_notification`
items with the task, a `summary`, the `detail` the agent read and a `source`.
`sessionTimeline` gives them `inbound` and `notifications` entries; a
notification steered into a working turn is one of its steps instead.
Timelines render both through the shared `session-input` rows, whose
expanded details end in a link to the source; hosts map sources they own
(a chat in another project) with `sourceHref` and fall back to the default
`session:`, `run:` and surface keys. Queues edit only `user_message` turns.
Never key behavior meant for the person (undo, recall, edits) on anything
but `user_message`; a chat's provisional title comes from a person's or an
inbound message, never a notification.

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

The registry is the one implementation of the chat timeline, its steps, queue
and input rows (ADR 0218). Edit `packages/registry/src` first, then rewrite the
installed copies with `bun scripts/registry-copies.ts --sync desktop` (and
`--sync pwa`). The desktop copy lives in `src/renderer/components/catamorphic`.
A copy differs from the registry only in import specifiers;
`bun scripts/registry-copies.ts` (and `bun run test:scripts`) fails on any other
difference, a partly installed item, or a copy that imports a desktop module.
Pre-existing differences are listed in its `KNOWN_DRIFT` with a reason, and
that list only shrinks.

Desktop behavior enters through the timeline's host surface, never an edit to
the copy: `renderAttachment` (the `ContextPill` with its previews), `Hint`
(`ShortcutHint`, with `jumpShortcut` for PageUp), `renderLink` and `onLinkClick`,
`sourceHref`, `resolveToolIcon`, `onReauth`, `backgroundCommands` and
`workDisplay`. Rows are memoized: keep render-affecting slots stable
(`useCallback` or module-level functions); action callbacks may change every
render. The timeline's motion classes (`cat-fade-in`, `cat-fold-away`,
`cat-step-in`, `cat-gap-in`, `cat-swap-*`, `cat-reveal` with its
`data-entering` and `data-moving`, `cat-grow`), its scroll pinning (`cat-scroll-anchor` with
`data-pinned`, set only while the chat follows and nothing in it is pressed
or selected) and `cat-settled` live in `@catamorphic/ui/styles.css`, which
the renderer stylesheet imports. The timeline's press and key listeners on
the document are listed in the desktop's design lint.

Registry build emits the installable JSON; source edits alone do not update that
output. Build the React package first because consumers resolve its declarations
and implementation from `dist`.

`packages/registry/src/examples/embedding.tsx` is a typechecked host example.
Use hook tests for concurrency and scope changes, and native Electron tests for
paste, focus, link hit targets and surface identity. Neither substitutes for the other.

Queue mutations resolve to `true` only after server confirmation. A `false` result keeps the shared queue editor and its draft open; host callbacks must preserve that outcome.

## Agent questions

Question batches are durable session requests with a `blocking` flag (default true).
Answer with `useAgentChat().respond(requestId, { kind: "question", answers, attachments })`,
one answer per question; an answer in the person's own words may hold
attachment markers, and `attachments` holds each answer's pills in marker
order (ADR 0244). Core gives the asking agent text answers with the text pills
rendered in; their images and documents follow as a steered message carrying
the answer (its card takes the pills from the request).
Non-blocking
questions stay answerable while work continues and after the turn finishes.
Collapsing a question preserves its draft. The existing inbox delivers answers to
the current harness or starts a continuation if the turn has already ended.
See ADR 0122 and the question schemas in `@catamorphic/sandbox`.

A message sent while a blocking question waits reaches the agent in the same
turn, attachments included, and the question stays open as "Answer when ready"
(ADR 0195). A permission request is withdrawn instead. Each question also has
an Other answer (ADR 0244), which the desktop types in the composer's own input
(`components/answer-input.tsx`): it glides, takes pills, and attaches pasted
files through the dock's own attaching. The composer still takes free text,
and its placeholder says so while a question is open. The waiting status sits
in the panel header. Answers render in history as the questions and what was
picked or written, pills in place: from the resolved request, or a later
answer message's `answer`. Agents close questions a reply settled with `close_questions`.

A response shows the moment it is sent, as a sent message does:
`useAgentChat` reads its request as answered with it until the session's own
request moves on, and a refused one asks again. The answer takes the
question's place in the conversation in the same frame, and enters once
(the answer message that may follow is the same card). The desktop keeps the
answered panel as it was, inert at once, while it closes
(`components/closing-collapsible.tsx`), starting two frames on so the
frame that swapped the answer in never shows its close as a jump.

Attachment preparation shows on the composer's attach button. Never add a row
above the composer for transient state: it moves the dock and any open question.

## Consent belongs to the conversation

Session tool approvals and native app-access consent are durable blocking
session requests (`approval` and `elicitation`), shown in the chat with the tool
and what it sends and explicit Allow once, Always allow and Deny choices. Do not
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
chips (including expanded group members), response links and sidebar
previews use these primitives. Do not add per-surface hover timers or standalone
preview modals. A preview opens on keyboard focus, stays open while the pointer
moves into it, and dismisses on Escape without opening the resource.

Use the installable `ResourcePreviewContent` for bounded file/Markdown/media and
resource summaries. Keep Markdown's default URL sanitization and raw HTML disabled;
embedded images and links in previews are inert so hovering never navigates or
loads remote content. Preserve filenames, locations, truncation and retry states.
Work's chips carry host-resolved file paths/URLs in their data when available, so they preview
the same content as a response link to that resource. Terminal previews read a
bounded recent-output snapshot through the existing terminal buffer API and the
shared terminal-text sanitizer. Workflow and app previews use catalog metadata;
hovering never executes a workflow or mounts an app.

Past three chips of one kind, Work's chips fold into a group labelled with the
plural type: Terminals, Apps, Workflows, Files, Pages, Chats, Subagents or App
views (ADR 0239). Show the count separately. Clicking the group discloses every member; each member retains its
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
