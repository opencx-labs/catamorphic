# 0218 — One chat timeline: the registry, installed as copies

- **Status:** Accepted
- **Date:** 2026-10-11

## Context

The chat timeline is installable registry source (`packages/registry`,
shadcn-style), and the desktop and the PWA install it as copies. In #181 the
desktop copy forked: it gained memoized rows, one node per sent message,
notes folding into the answer's steps, the steps model with durations and
background commands, the activity line with the turn's clock, and Restore to
here, while the registry kept older behavior and made different choices. The
PWA and `agent-chat` embedders got none of it, fixes landed twice or once,
and an old test compared only two files.

## Decision

The registry is the one implementation of the chat timeline, its steps, the
queue and the input rows. Hosts install copies that differ from the registry
only in import specifiers.

- The merged item is built from the desktop's behavior and DOM, plus the
  registry's wins (exit codes, rename labels, failed steps, `session:` and
  `run:` links, Restore failure feedback, retry countdown and Stop on any
  retrying turn, the queue's gated controls and attachment-free drafts).
- Host-specific pieces enter through slots, never edits to a copy:
  `renderAttachment(attachment, place)` (the desktop's `ContextPill`),
  `Hint` (`ShortcutHint`, with `jumpShortcut`), `renderLink` and
  `onLinkClick`, `sourceHref`, `resolveToolIcon`, `onReauth`,
  `backgroundCommands` and `workDisplay`. Defaults are a plain pill and the
  native title. Rows are memoized; callbacks reach them through a
  ref-backed context, render-affecting slots through a value context.
- Shared motion lives in `@catamorphic/ui/styles.css` as namespaced `cat-*`
  classes; the components also move on with timers when a host lacks them.
- `scripts/registry-copies.ts` checks every installed copy in the
  repository's script lane and rewrites copies with `--sync <host>`. It fails
  on drift, partial installs, and copies importing anything but
  `@catamorphic/*`, declared packages or siblings. Known drift is listed
  with a reason and is a ratchet: an entry whose copy matches again fails.

Rejected: keeping the desktop fork with its own tests (every fix twice,
embedders behind), and moving the turn-row projection into
`@catamorphic/react` (it is presentation, how a turn folds for display, so it
ships with the item as `turn-rows.ts`).

## Consequences

Embedders (the PWA, `agent-chat`) change behavior: undo moves from the
answer's footer to "Restore to here" on the person's message, also for
failed and interrupted turns; changed-file chips and the usage label are
gone; copy and fork sit beside every settled reply; notes fold into the
answer's steps once a turn settles and each step shows its own duration;
interrupted turns read as a summary, retrying turns as an error card with a
countdown and Stop, undone turns under one divider; a failed send stays in
place with "Send again"; attachments render as pills; a jump-to-previous
button appears once the chat scrolls. `resolveRequest` became `requests`;
testids `chat-session-notice`, `chat-retrying`, `chat-turn-undone`,
`chat-rollback*`, `chat-sending-message` and `chat-failed-message` became
`chat-divider`, `chat-auto-retry`, `chat-undone-divider`, `chat-restore*`
and `data-pending-message`.

Changing the timeline now means editing the registry and syncing both hosts
in the same change; the registry's unit tests, including a DOM contract
test for the end-to-end suites' selectors, cover all of them.
