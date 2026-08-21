# TODO

- **Full-stack Claude Code e2e via a fake CLI.** The ask_user flow now has
  three pins: harness unit tests (mocked query), the harness↔core seam
  integration test (`packages/claude-code/src/__tests__/
  ask-user-core.integration.test.ts` — real AgentSessionsService + real
  Postgres, DATABASE_URL-gated), and the renderer panel via the fake-agent
  e2e. The one uncovered layer is the SDK↔CLI boundary itself: a fixture
  "fake claude" executable speaking the SDK's stdio protocol (pointed at
  via `pathToClaudeCodeExecutable` under an e2e env flag) would let the
  desktop e2e drive a REAL Claude Code harness end to end — questions,
  permission round-trips, background tasks — without model calls. Worth
  building once; every harness regression class lands in it.
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
- **ACP harness.** Project agent definitions (ADR 0050) accept
  `kind: "acp"` today but resolve it to a fail-fast "not built yet"
  entry. Build the real ACP client harness: a `CodingAgentProvider`
  speaking the Agent Client Protocol over both transports — a local
  command (`acp.command`, stdio) and a remote endpoint (`acp.endpoint`).
  The remote-Catamorphic-server agent story rides the endpoint transport:
  a stock server exposes its agents over ACP and a project definition
  points at it, with `credentials.source: "secret"` carrying the token so
  no personal consent is involved. Map ACP's session/turn/interrupt
  semantics onto the provider contract; per-agent home-dir isolation for
  the command transport.
- **TS `defineAgent` layer over project agent JSON.** The committed
  `agents/<slug>.json` files are the substrate (ADR 0050); add the
  authoring layer: `defineAgent({...})` in project code, discovered by
  `@catamorphic/parser` like `defineSecrets`, compiled/projected into the
  JSON files (generated-projections style, ADR 0041) so the registry,
  consent hashing, and HTTP surface stay unchanged. Gives authors types,
  autocomplete, and refactors; the check script should flag drift between
  source and generated JSON.
- **Long term: a default self-hostable Catamorphic server + remote MCP.**
  Today the workflow-tools MCP endpoint (ADR 0042) is local and
  host-proxied. The direction: a stock Catamorphic server people run on
  their own infra; Catamorphic desktop connects to it and calls
  MCPs/workflows remotely instead of locally. Identity is settled (ADR
  0053: the host's `identity` resolver returns full or scoped identities;
  the server is that resolver plus a token-issuing auth adapter and a
  config file); embed first, then promote the reference host into the
  stock server. Motivating case: our customer engineering team wants
  AI-built custom issue trackers per customer — customers as scoped
  viewers of per-customer apps, tenants connecting to their own workflow
  tools over MCP.
- **ADR 0055 follow-ups (company brain).** The six steps landed (scope kinds
  + scoped agent sessions; roles/memberships/`identityFromBearer`; project
  store + documents surface + `context.caller/documents/host`; project MCP
  endpoint; desktop remote projects; proposals + publications). Left for
  later, in rough priority: (a) desktop remote projects — auto-sync on focus
  / interval, a per-version "restore" button in the history modal, revoking
  publications from the desktop, and surfacing the project MCP endpoint's
  skills/agents in the connect flow;
  (b) `context.host` typed through the generated projections (ADR 0041) so
  `host.acme.crm.lookupAccount` is typed in project code; (c) an admin UI
  for memberships/roles/publications in the desktop (today: HTTP + agent);
  (d) the reader working copies (`catamorphic-reader`, `-proposals`) share
  the per-user clone layout — a stock server should give them a bare/shared
  checkout; (e) the store's `search` reads whole program trees for grep on
  every call — index program text like store text once brains get large;
  (f) proposals: PR reviews rendered natively; a "propose this edit" action
  in the desktop editor for program files in remote projects; (g) public
  publications for apps (today: documents only).
- **Provider auth health, before the send fails (t3-code-inspired).** t3
  Code probes each provider in the background (`claude auth status`, a
  never-yielding Claude Agent SDK session that reads account/subscription
  data without an API call) and shows a dismissible "X is unauthenticated
  — sign in" banner over the chat. We now classify OAuth-expiry turn
  failures and auto-retry after re-login, but we only learn AT send time.
  Adopt the probe: check on app focus/resume + powerMonitor wake (the
  laptop-lid case), read the keychain/file expiresAt where cheap, and
  surface a quiet banner with the same one-click re-login. See
  memory reference_t3_code.md; probe pattern in t3's
  apps/server/src/provider/Layers/ClaudeProvider.ts.
- **Usage page follow-ups (ADR 0057, t3-code-inspired).** Shipped
  2026-08-21: transcript-scanned usage tab + composer context ring.
  Remaining: (a) an e2e with seeded fixture transcripts (the IPC has no
  seam yet); (b) a Codex rate-limit/quota gauge — the rollouts'
  `token_count` lines already carry `rate_limits.primary.used_percent`
  and `resets_at`, which the SDK stream never exposes; (c) a Codex
  context ring — `model_context_window` is also transcript-only, so the
  meter needs a transcript-side assist; (d) an app-only scope filter by
  joining transcript session ids to `agent_sessions.provider_session_id`;
  (e) per-subagent token attribution (Claude `isSidechain` records);
  (f) surface per-reply cost in the step log from `metadata.usage`.
- **Remote machines for agents (t3-code-inspired).** t3 runs agents on
  preconfigured remote environments over SSH (packages/ssh: auth,
  command, tunnel) and tailscale, with pairing-link auth for its
  web/mobile clients. When remote agent usage solidifies (self-hostable
  server vision), mine those packages for the transport/auth shapes.
