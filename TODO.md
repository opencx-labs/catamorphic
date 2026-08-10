# TODO

- **Chat: git-changes tree view.** The per-turn "touched files" chips were
  removed from chat replies (most users don't care; the app chip already
  jumps to the result). Replace them with a proper git-style changed-files
  tree for the users who want to review what a turn did — grouped by
  directory, add/modify/delete badges, click-through to the editor diff.
  The data is already persisted per assistant message
  (`metadata.changedFiles`, with `path` + `kind`).
- **Port chat-timeline enhancements to the registry copy.** The desktop's
  `chat-timeline.tsx` gained the collapsed per-turn step log (tool calls /
  commands / file edits with expandable payloads and MCP connector icons),
  dropped the touched-files chips, and gates the jump-to-previous arrow on
  scrollability. `packages/registry/src/chat-timeline` is the installable
  source of truth and still has the old behavior.
