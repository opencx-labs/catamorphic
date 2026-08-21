# 0056 — Agent configuration: one surface, layered defaults, enforced capabilities

- **Status:** Accepted
- **Date:** 2026-08-21
- **Builds on:** 0038 (coding-agent registry), 0050 (project agent
  definitions), 0052 (skills as commands), 0054 (tool permissions),
  0055 (roles and scoped agents)

## Context

Agents exist (0038), are shareable (0050), and their tool access composes
correctly (0054) — but *configuring* one is thin. The settings form edits
name/model/effort/auth; everything else an agent *is* has no surface:

- No per-agent instructions. A project agent gets `agents/<slug>.md`; a
  profile agent has no persona at all.
- No harness options. Claude Code's permission mode is hardcoded
  `acceptEdits`; Codex's sandbox mode is plumbed but never set; nothing
  controls Claude Code's auto-memory, which some users flatly don't want.
- Capabilities are only half-enforced. Profile agents honor a picked
  connection subset; a committed definition's `connections` is
  informational (0050's v1 cut). Skills reach every agent identically.
- One global default agent. The profile roster's `defaultAgentId` answers
  every new chat in every project; a project cannot ship its own default,
  and a user cannot prefer a different agent per project.
- Effort stops at `high`. The harnesses go further (Claude's
  `xhigh`/`max`, Codex's `xhigh` — "ultramode" is reasoning effort), and
  the normalized scale hid that headroom.
- Skills are two-tier (project, host). There is nowhere to put a skill
  that is *mine* — not committed, not shared with the team.

## Decision

### 1. The agent schema grows five fields (both scopes)

Profile agents (`agents.json`) and committed definitions
(`agents/<slug>.json`) gain, mirrored:

- **`instructions`** (profile) — the agent's own main prompt. The exact
  analogue of a project agent's `agents/<slug>.md` persona: prepended at
  the provider boundary by the same `PersonaCodingAgent`, so it leads and
  the host playbooks follow. Harness-neutral by construction — Claude
  Code appends it to its preset, Codex carries it in
  `<session_instructions>`, the built-in agent takes it as instructions.
  We deliberately do NOT write CLAUDE.md/AGENTS.md files: Claude Code
  does not read AGENTS.md natively, and repo files belong to the project,
  not to one agent. The persona is the abstraction; per-harness delivery
  is a detail.
- **`mode`** — `"read-only" | "edit" | "full-access"`, default `"edit"`.
  One normalized operating mode, like effort, mapped per harness:
  Claude Code `plan | acceptEdits | bypassPermissions`; Codex
  `sandboxMode read-only | workspace-write | danger-full-access`. The
  built-in agent is sandboxed with draft sync-back — mode does not apply
  and the UI says so.
- **`memory`** — boolean, default true. Claude Code only. `false` spawns
  the CLI with `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, the SDK's supported
  kill-switch for auto-memory. Works for every auth mode (it's per
  process, not per settings file). Other harnesses have no memory; the
  toggle is hidden.
- **`skills`** — `{ mode: "all" } | { mode: "picked"; names: [...] }`
  (profile) / `skills: string[]` (committed; absent = all). Which skills
  the agent is *offered*: the system-prompt skills section lists only the
  picked set, and a picked agent drops the host-skills plugin (Claude
  Code's native tier). `read_skill` stays unfiltered in v1 — the skills
  section is the offer, the tool is a file reader; gating reads is a
  follow-up if it ever matters.
- **`connections` becomes enforced** for committed definitions: names
  are matched against the member's profile connections (by connection
  name), producing the same picked assignment a profile agent has.
  Absent still means "all", matching profile agents. 0050's
  informational-v1 cut is closed.

The effort scale extends to **`low | medium | high | xhigh | max`**.
Claude Code passes all five through; Codex clamps `max → xhigh`; the
built-in agent maps to thinking budgets (and clamps to `high` for OpenAI
reasoning effort). "Ultramode" is exactly this — a reasoning level, not a
separate mechanism, as suspected. The session CHECK constraint and HTTP
schemas widen accordingly.

Consent (0050): `mode` joins the definition hash — a collaborator
flipping a committed agent to full-access must re-earn consent. `memory`
and `skills` stay outside it (they narrow or touch nothing personal),
like `connections` and `toolPolicies`.

### 2. The default agent is layered, most-specific-first

The default agent answers any new chat (a session with a null
`agent_id` re-resolves it every turn). Resolution for project P:

1. **The user's per-project choice** — `projectDefaults[P]` in the
   profile's `agents.json`. Their override, theirs alone.
2. **The project's committed default** — `defaultAgent: "<slug>"` in
   `.catamorphic/project.json` (the manifest 0043 earmarked for exactly
   this kind of project-scoped config), naming a committed project
   agent. Travels with the repo; every collaborator gets it.
3. The profile's global `defaultAgentId`.
4. The first roster agent.

`CodingAgentRegistry.defaultAgentId()` gains an optional `projectId`;
core's `resolveAgent` passes the session's project. A layer that names a
missing agent is skipped; a project default the user hasn't consented to
resolves normally into 0050's fail-fast consent pointer — honest, not
silent. The default agent is an ordinary agent: editable, removable
(removal re-points the layer that named it).

### 3. One configuration surface: the agent modal

A tabbed modal (General / Prompt / Capabilities / Auth) is THE way to
configure an agent — opened from the palette ("Configure agent…" → agent
picker) and from Settings (whose inline edit form it replaces). It
composes the existing field components (connections assignment, the
tool-policy editor with its workflows row) plus the new fields. Project
agents open read-only: their definition is committed code, so the modal
shows it, surfaces consent state, and points at `agents/<slug>.json` —
editing files is editing the agent.

### 4. A user skill tier

`profiles/<id>/skills/<name>/SKILL.md` — personal skills, never in any
repo, following the same layout as project skills. `SkillsService` grows
a live-read `userSkills` hook and a third `source: "user"`; shadowing is
project > user > host (committed team doctrine outranks personal
customization; personal outranks shipped defaults). User skills appear
in the palette and the agents' skills section like any other tier, and
are excluded from the shared surface (0055's project MCP) — they are
personal by definition.

This is the first instance of a general principle: **user-scoped
resources** — things a member keeps in the product but out of the shared
project. Local-only lives under the profile dir (this tier); *synced*
per-user state has a designed home as a self-scoped store subtree
(`store/users/{user}/**` via a role grant — 0055's machinery, zero new
mechanism) when a stock server exists to sync against.

## Consequences

- Editing instructions/mode/memory/skills rebuilds the provider (they
  are construction-time), so live sessions re-anchor on their next turn
  — same trade 0038 made for agent switching. Model, effort, and tool
  policies keep traveling per-turn/live and never rebuild.
- The Claude Code harness's `permissionMode` becomes an option with the
  old hardcoded value as default; the test asserting the hardcode now
  asserts the mapping.
- Remote agents for project joiners are already 0050 + 0055: a committed
  definition (consent-bound or secret-credentialed), named in roles,
  adoptable via the picker, now with a project default to land on. The
  transport for agents hosted *elsewhere* stays the reserved `acp` kind
  (TODO "ACP harness") — nothing here preempts it.
- Slack (Claude-Tag-style) and code-host integrations (a reviews-only
  agent) are consumers of this schema, not new mechanisms: an agent with
  narrowed `toolPolicies` + a trigger/workflow binding. Recorded in
  TODO.md; not built here.
- v1 cuts: `read_skill` is not gated by the skills pick; user skills ride
  the prompt note (no per-agent native plugin materialization); the
  committed `skills` list, like `toolPolicies`, is outside the consent
  hash.
