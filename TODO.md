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
  seam: inline comments, approvals, merge-from-app; a human-facing worktree
  cleanup surface (agents can create and adopt worktrees, but Catamorphic
  intentionally never removes an external worktree automatically); diff-tab
  niceties (stage/discard hunks, open-file jump);
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
- **Agent configuration follow-ups (ADR 0056).** v1 cuts to close when
  they start mattering: `read_skill` is not gated by an agent's picked
  skills (the prompt's skills section is the offer; the tool reads any
  tier); a picked-skills Claude Code agent loses native Skill-tool access
  to app skills (the plugin is withheld whole — a per-agent filtered
  plugin materialization under `agent-homes/` would restore it); user
  skills ride the prompt note only (no native plugin). Also: a "remote
  sync" home for user-scoped state beyond skills — the designed shape is
  a self-scoped store subtree (`store/users/{user}/**` via a role grant,
  0055 machinery) — the stock server's member role (ADR 0059) already
  grants exactly that subtree.
- **Personal agents and agent-to-agent communication.** Give personal and
  project agents a durable, policy-controlled way to send attributed messages
  to other visible sessions. Messages must remain distinguishable from user
  messages and support message-only delivery, queueing the next turn (waking
  an idle or older session), or interrupting the current turn before delivery.
  Move queue authority out of the React client into a persisted session inbox
  with idempotency, provenance, per-agent send/receive and delivery-mode
  policy, privacy/incognito enforcement, and explicit cross-project limits.
  Cross-host delivery must follow the authoritative session through a durable
  mailbox rather than treating transcript mirroring or a direct desktop
  callback as message transport.
- **Profile-scoped agent workflows.** After per-agent, per-project workflows
  are established, add private workflows owned by a profile-scoped personal
  agent and usable across projects without entering project git history.
  Define their local source storage, project access boundaries, lifecycle,
  and optional profile sync before implementation. This is intentionally
  deferred from temporary project Watchers.
- **Agent channel integrations: Slack, code review.** The per-agent
  schema (capabilities + tool policies + mode) is the substrate; what's
  missing is the *binding* of an agent to a channel. Slack: a
  Claude-Tag-class experience — a project agent wired to a Slack
  connector answers mentions/threads, with the agent's toolPolicies
  narrowing what it may do there ("seniors may post, juniors may not" is
  already expressible in roles). Likely shape: a trigger kind
  (`slack.mention`) + a workflow that opens an `ask_agent` turn, so it
  rides ADR 0039/0042 rather than new machinery. Code review: an agent
  assigned ONLY to reviews — a `github.pr-opened` trigger (CodeHost
  seam, ADR 0045) invoking a read-only-mode agent whose persona is the
  review doctrine, posting via the PR-review surface. Both are
  consumers of ADR 0056; neither needs new agent-side schema.
- **Claude plugin for Catamorphic project connections.** Ship a general
  Catamorphic plugin for Claude so someone invited to a project can use the
  project without installing Catamorphic Desktop. During installation or
  first authorization, ask for the credential-free project or invitation
  link, complete the server's ordinary OAuth flow, and configure that
  project's MCP endpoint automatically. Project choice and authentication
  belong to the invitation/onboarding path outside the desktop; the desktop
  should not permanently advertise "Use in Claude" to someone already using
  Catamorphic. Preserve the same scoped identity and durable session model so
  agent conversations begun through Claude appear in the project's ordinary
  session history with their source attributed.
- **TS `defineAgent` layer over project agent JSON.** The committed
  `agents/<slug>.json` files are the substrate (ADR 0050); add the
  authoring layer: `defineAgent({...})` in project code, discovered by
  `@catamorphic/parser` like `defineSecrets`, compiled/projected into the
  JSON files (generated-projections style, ADR 0041) so the registry,
  consent hashing, and HTTP surface stay unchanged. Gives authors types,
  autocomplete, and refactors; the check script should flag drift between
  source and generated JSON.
- **Stock self-hostable server: SHIPPED 2026-08-21 (ADR 0059,
  `apps/server`)** — docker-run-able, zero external services (PGlite +
  bare git origins + local-process execution + `auth.json` tokens),
  invites over `POST /admin/invites` (deploys `roles/member.json`,
  grants membership, returns connect links), unique mDNS hostname for
  LAN reach, `DATABASE_URL` opt-in for real Postgres. The mobile PWA
  (`apps/pwa`, ADR 0058) is its first-class client, and desktop QR
  pairing (ADR 0060) covers the personal-server case. Remaining
  follow-ups: **passkeys** for self-serve token renewal (the `renew=`
  slot on connect links is still empty), **OIDC + email-domain
  auto-membership** (the company-brain door), an **admin/membership UI**
  (today: curl + the printed admin token), and remote MCP for the desktop (calling a remote
  server's workflow tools instead of local ones — the original
  motivating case: per-customer apps with customers as scoped viewers).
- **ADR 0055 follow-ups (company brain).** The six steps landed (scope kinds
  + scoped agent sessions; roles/memberships/`identityFromBearer`; project
  store + documents surface + `context.caller/documents/host`; project MCP
  endpoint; desktop remote projects; proposals + publications). Left for
  later, in rough priority: (a) desktop remote projects — periodic auto-sync,
  a per-version "restore" button in the history modal, revoking
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
- **Review-deferred architecture cleanups (2026-08-21 code review).** Three
  confirmed-but-invasive findings deferred from the fix pass: (a) slash
  command listing as an optional provider capability (today: a Claude Code
  special case across the ipc gate, the SlashEntry shape, and a hardcoded
  badge; Codex has ~/.codex/prompts waiting); (b) per-harness transcript
  usage-sources so the desktop scanner stops owning each CLI's on-disk
  format (usage-transcripts.ts provider switches + hardcoded home
  layouts); (c) an injected e2e-fakes layer replacing the inline env-var
  seams (CATAMORPHIC_E2E_AUTH_HEALTH, CATAMORPHIC_E2E_FAKE_AGENT) so
  mixed-state fixtures become possible and the usage page gets its e2e.
- **Mobile/mirroring follow-ups (ADRs 0058-0062).** Known and
  deliberate, in rough value order: (a) the mirror re-pushes the whole
  transcript every settled turn (idempotent but O(n) per turn) - track
  the last acked message id and push the tail, full push on 409;
  (b) `/admin/usage` aggregates in JS over bounded rows - move the sums
  into SQL when a team's history outgrows it; (c) shared modules for
  things now hand-synced across apps: the theme presets, the chat-icon
  vocabulary (an agent-facing contract, so drift is a real bug), the
  question panel's answer protocol, the connect-link parse/build
  vocabulary (parser in pwa+desktop, builders in server+pairing), and
  the CDP e2e client (desktop and pwa harnesses); (d) drive the pwa e2e
  against `buildStockServer` with the fake agent instead of the
  hand-written `scripts/dev-server.mjs` wire fake; (e) memoize the pwa
  chat timeline (React.memo rows, useMemo turn steps) - it re-parses
  every message's tool payloads on each 500ms poll; (f) desktop-side
  composer lock on a forked session (the PWA locks; the desktop only
  shows the marker row).
- **Remote machines for agents (t3-code-inspired).** t3 runs agents on
  preconfigured remote environments over SSH (packages/ssh: auth,
  command, tunnel) and tailscale, with pairing-link auth for its
  web/mobile clients. Our pairing story landed differently (QR device
  tokens on the desktop LAN listener, ADR 0060; invite links against the
  stock server, ADR 0059); what's still worth mining from t3 is the SSH
  remote-environment transport for running agents on OTHER machines.
