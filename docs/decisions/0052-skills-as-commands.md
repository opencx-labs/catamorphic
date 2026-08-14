# 0052 — Skills as commands, and the agent-initiated auth loop

- **Status:** Accepted
- **Date:** 2026-08-14
- **Builds on:** 0010 (skills in the project repo), 0049 (doctrine is the
  embedder's), 0050 (project agent definitions), 0051 (no project
  templates)

## Context

Skills existed as project files (`.agents/skills/<name>/SKILL.md`, ADR
0010) that agents happened to read, but nothing let the *user* invoke one,
and nothing let the *host* ship one — "push this project to GitHub" has no
home in a fresh empty project's repo. Separately, agents had no way to ask
for a connector: when a task needed a service that wasn't connected, the
conversation dead-ended at "please set that up in Settings".

## Decision

**A skill invocation is a message.** The palette and the composer's `/`
commands are launchers that compose one harness-neutral sentence — `Use
the "<name>" skill.` (arguments appended after a colon) — and send it to a
chat. No new execution machinery: skills stay files, chats stay the only
runtime.

### The host tier

`CatamorphicCoreConfig.hostSkills` (mirrored by `createCatamorphic`) is a
third doctrine hook with the exact ADR 0049 contract: receives the
framework defaults keyed `<name>/SKILL.md`, returns the host-final map,
resolved once at boot into `core.hostSkillFiles`. `SkillsService` merges
the tiers — `GET /projects/:id/skills` now returns `source: "project" |
"host"`, sorted by name, a project skill shadowing a host skill of the
same name — and `SkillsService.read(name)` returns content from either
tier. The framework default set ships `publishing-to-github`: the gh-CLI
flow (auth status → `gh auth login --web` in a visible terminal → confirm
name/owner/visibility → `gh repo create --source=. --push` or push to an
existing empty repo), which also demonstrates the agent-initiated auth
pattern for CLIs. Host skills never touch the project tree — the ADR 0049
alien-embedder test still asserts the on-disk set equals the resolved
seeds exactly.

### Harness delivery (no symlinks)

- **claude-code:** the desktop materializes `core.hostSkillFiles` under
  app data as a Claude Code plugin (`.claude-plugin/plugin.json` +
  `skills/…`, rewritten each boot) and appends it in `resolveMcp` — so it
  rides the existing `plugins` option, the provider cache key covers it,
  and skill discovery/preloading is fully native. The repo is never
  written to; core stays the source of truth.
- **Everything else:** `WorkspaceContextAgent` appends a Skills section to
  the session prompt — the two-tier model, the host-skill listing with
  descriptions, and how to load one: the new `read_skill` workspace tool
  (by-name, both tiers, wired to `SkillsService.read`) for tool-carrying
  harnesses, the materialized absolute path for tool-less ones (Codex).

### Renderer surfaces

Palette rows (`skill:<name>`, fetched fresh on every open per the ADR 0050
freshness rule) and a composer `/` menu over the same registry. Commit
semantics reuse what exists: with a chat focused, the row is an *action* —
the invocation is sent into that chat via a new registered-sender map
(the registerClose idiom) and the chat gets the scoped-command border
accent; with none, it's a *navigate* through `sendToAgent`
(float/tab per the Enter/⌘Enter rules). In the composer, `/` while typing
the command token opens the menu (↑/↓/Tab/Enter/Escape, menu before
recall), and a submitted `/name args` resolves to the invocation even with
the menu closed.

### Agent-initiated connector auth

A new `request_connection` workspace tool: the agent names what it needs
(a search query + one-line reason), the focused window opens the existing
connectors modal seeded with that query and a consent banner, and the tool
resolves with the names of connections installed before the modal closed
(diffed by connection id) — the agent requests, the user grants, secrets
never transit the chat. Tools can't mount mid-turn, so the tool result
tells the agent to end its turn; on a real install the renderer queues a
continuation message into the asking chat, which dispatches after the turn
settles — by then the provider cache key (which covers the MCP surface)
has rebuilt the harness, and claude-code's per-turn `resume` picks the new
servers up natively. The turn seam is the whole restart story; nothing new
was built for it.

## Consequences

- "Push this to GitHub" works in an empty project: palette →
  `publishing-to-github` → an agent runs the gh flow, including login.
- Embedders swap or extend the host skill set without forking, same as
  seeds and the standing prompt; the desktop passes no hook and gets the
  defaults.
- The e2e fake answers the literal invocation sentence with the real
  `read_skill` tool and `connect:` with the real `request_connection`
  tool, so the suites cover renderer → message → toolkit → core end to
  end.
- Codex still can't call the tools (no extra-tool hook); it gets listings
  and paths only.
- Skill arguments from the palette are deferred — the chat itself is the
  argument surface there; the composer form takes inline args today.
