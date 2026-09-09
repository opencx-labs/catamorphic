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
