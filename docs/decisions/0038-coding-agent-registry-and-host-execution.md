# 0038 - Coding-agent registry with per-session agents and host execution

- **Status**: accepted
- **Date**: 2026-08-04
- **Topology model refined by**: 0064
- **Runtime contract and topology model refined by**: 0067

## Context

Core accepted exactly one `CodingAgentProvider`, chosen at boot. The desktop
app needs several agents at once — the built-in sandboxed agent
(`AiSdkCodingAgent`) plus Claude Code and Codex harnesses running natively on
the user's machine, possibly several per harness on different accounts — with
per-session selection, mid-session switching, and per-session reasoning-effort
overrides. The one-agent model also hard-wired the dev-sandbox flow: every
provider was assumed to operate through the core `SandboxProvider`, but the
Claude Code and Codex CLIs work on local filesystem paths and ship their own
isolation (permission allowlists, OS-level workspace-write sandboxing).

## Decision

- `CatamorphicCoreConfig.codingAgent` accepts a single provider (wrapped into
  a one-entry registry) or a `CodingAgentRegistry`: `defaultAgentId()`,
  `get(id)`, `list()`, returning `RegisteredCodingAgent { id, provider,
  execution, defaults }`. Registries may resolve dynamically — the desktop
  reads per-profile config files live, so agents added in Settings need no
  server restart.
- Each registered agent declares an execution mode. `sandbox` agents keep the
  existing flow: per-(project, user) dev sandbox, workflow-skill staging, git
  baseline, post-turn draft sync-back. `host` agents run directly in the
  project's host directory, resolved via a new `hostProjectPathResolver`
  config hook; there is no sandbox and no sync step — edits land in place,
  and changed files are reported from the provider's `file_edit` events.
- Sessions store their agent (`agent_sessions.agent_id`, null = default), a
  per-session effort override (`model_effort`), and their original
  `system_prompt`. Provider anchoring is lazy: `create()` is a metadata
  write, and the first turn establishes the provider session (and sandbox,
  for sandbox agents). A new `update()` API switches a session's agent
  (dropping the anchor; the next turn re-anchors on the new provider with
  fresh provider-side context) or changes its effort; it 409s mid-turn.
- `CodingAgentProvider.sendMessage` gains optional `TurnOptions { model,
  effort }` with a normalized `low | medium | high` effort scale; each
  harness maps it onto its native knob (Anthropic thinking budgets / OpenAI
  `reasoningEffort` in `@catamorphic/ai-sdk`, the SDK `effort` option in
  `@catamorphic/claude-code`, `modelReasoningEffort` in
  `@catamorphic/codex`).

## Consequences

- The HTTP surface adds `agentId`/`effort` to session create, a `PATCH`
  session route, and `agentId`/`modelEffort` on session payloads; hosts that
  pass a single provider see no behavioral change.
- Host-execution turns modify the user's working copy directly — the
  "uncommitted draft" review model applies only to sandbox agents. Hosts
  choose which trade-off each agent makes; the desktop surfaces it as the
  harness choice (Built-in vs. Claude Code/Codex).
- A switched session's new provider starts from its own fresh context; the
  conversation history stays in `agent_messages` but is not replayed into
  the new harness. Working state carries over through the working directory.
