# TODO

- **Dev-shell follow-ups (ADR 0045).** PR review depth on the CodeHost
  seam: inline comments, approvals, merge-from-app; a worktree
  create/remove surface (today worktrees are made by agents/terminals and
  only *shown*); diff-tab niceties (stage/discard hunks, open-file jump);
  an isomorphic-git fallback for the read surfaces so "Changes" works
  without system git; right-click beyond the sidebar (tabs, chat rows,
  editor). Also consider surfacing which sidebar layer is active
  ("project config (broken)" case is already reported by the resolver).
- **Collaboration on the git backend (next slice after ADR 0044).**
  Invite flow (= repo access on the code host), PR review rendered
  natively in the app, and PR-first "review mode" sync: when a project
  declares review mode (likely in `.catamorphic/project.json`), auto-sync
  stops pushing `main` and work flows through branches + PRs instead —
  resolves the direct-push vs open-PR race deliberately deferred in
  ADR 0044. Also: a calm sync-status pill in the UI (up to date /
  syncing / diverged→rescue branch), and surfacing checkpoint history
  per chat reply via `agent_messages.commit_sha`.
- **Registry git-panel: drafts are now commits-ahead.** ADR 0044 made
  "draft" mean local-commits-not-yet-pushed instead of a dirty tree;
  `git-panel`/`useCommitChanges` in packages/registry still assume the
  dirty-tree model. Rework them (and discardDraft semantics) onto the
  checkpoint model.
- **Claude Code persona parity.** The claude-code harness passes a
  raw-string systemPrompt (replacing the SDK preset), so those sessions
  get the core paragraph + workspace playbook but none of the desktop
  persona (tone, task guidance) the built-in agent has. Decide: preset
  + append, or share the desktop INSTRUCTIONS across harnesses.
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
- **Long term: user-connected remote blob storage.** Projects will hold
  documents and media, not just code. Code/text stays in git (GitHub as
  the collaboration backend), but large binaries don't belong there —
  let users connect their own blob store (S3/R2/Drive-style) that the
  project references, so teammates pull code via git and blobs via the
  configured store. Needs: a pointer format in-repo (git-lfs-like or our
  own manifest), per-project storage config, agent awareness of what's a
  blob vs. text. Parked until project structure + local/remote sync land.
- **Long term: a default self-hostable Catamorphic server + remote MCP.**
  Today the workflow-tools MCP endpoint (ADR 0042) is local and
  host-proxied. The direction: a stock Catamorphic server people run on
  their own infra; Catamorphic desktop connects to it and calls
  MCPs/workflows remotely instead of locally; permissions plus the ability
  to publicly expose apps/MCP endpoints, with per-tenant/per-project auth
  (likely host-issued bearer tokens bound to tenant + project — Catamorphic
  stays out of the user/OAuth business). Motivating case: our customer
  engineering team wants AI-built custom issue trackers per customer — one
  project/tenant each, tenants connecting to their own workflow tools over
  MCP.
