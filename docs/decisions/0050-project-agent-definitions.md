# 0050 — Project agent definitions: committed agents, consent-bound credentials

- **Status:** Accepted
- **Date:** 2026-08-14
- **Builds on:** 0033 (user-declared secrets), 0038 (coding-agent registry),
  0043 (general-purpose projects), 0049 (doctrine is the embedder's)

## Context

Agents were purely personal: each profile's `agents.json` roster, configured
per machine, invisible to collaborators. But an agent tuned for a project —
a support-triage persona, a codebase-specific reviewer — is a *work
product*: it should version with the project, travel through clones, and be
usable by every collaborator without re-configuration. ADR 0010 put skills
in the repo for exactly this reason; agents needed the same move.

The blocker is trust. A committed definition is collaborator-authored code.
If checking out a repo made its agents runnable on *my* API key or CLI
login, any collaborator could change the persona file — or the harness, or
the model — and my next turn would spend my credentials running their
words. Skills don't have this problem (they're advisory text read by an
agent I already chose); agent definitions *are* the choice.

## Decision

### Two scopes

**Personal agents** stay exactly as they are: the profile's `agents.json`
roster (ADR 0038). **Project agents** are committed files:

```
agents/<slug>.json    # the definition
agents/<slug>.md      # optional persona — the agent's system prompt
```

A *visible* directory, unlike `.agents/skills/`: agents are work products
the team authors and reviews, and per 0043's lazy spirit the directory
exists only when agents do. The persona file is referenced implicitly by
slug — no path field to get wrong.

### The JSON substrate (schema v1, in core)

```jsonc
{
  "version": 1,
  "name": "Support Triage",
  "kind": "claude-code",            // "claude-code" | "codex" | "builtin" | "acp"
  "model": "claude-fable-5",        // optional
  "effort": "high",                 // optional
  "description": "…",               // optional
  "credentials": {
    "source": "profile",            // "profile" (default) | "secret" | "local"
    "secret": "ANTHROPIC_KEY"       // when source = "secret": project-secret name
  },
  "connections": ["slack"],         // required connectors — informational v1
  "acp": { "endpoint": "…", "command": ["…"] }   // reserved for kind "acp"
}
```

Zod-validated in core (`AgentDefinitionsService`), exposed as
`GET /projects/:id/agents`. Invalid files are *reported* per entry with
their error, never thrown — one typo'd definition can't take down the
roster, and hosts show it disabled with the reason. Unknown top-level keys
are stripped (evolution inside a version); an unknown `version` is a clear
"unsupported version" entry. JSON is deliberately the substrate: a future
TS `defineAgent` layer (parser-discovered, like `defineSecrets`) compiles
*to* these files; nothing downstream changes.

### Registry resolution: scope in the id

Core's `CodingAgentRegistry.get(id)` is id-only, so project scope is
encoded in the id: **`project:<projectId>:<slug>`**, stored on sessions
like any agent id. The desktop registry parses it, reads the definition
from the project folder, checks consent, and builds the provider through
the same harness construction paths profile agents use (per-turn dynamic
resolution, per-agent home-dir mechanics, the friendly-error and workspace
decorators). The persona file is prepended to the session system prompt at
the provider boundary. Slugs are restricted to `[A-Za-z0-9._-]` so ids
always parse.

### Binding and consent (the security core)

Before a project agent runs with a user's OWN credentials
(`source: "profile"` or `"local"`), the user's profile must hold a consent
record for `(projectId, slug)` bound to the **definition hash**: a stable
hash over the *sensitive* fields — kind, model, credentials, acp
transport, and the persona file's content hash. Display fields (name,
description, connections) are excluded; editing them must not invalidate
consent. Any covered change ⇒ the stored hash no longer matches ⇒ consent
is stale ⇒ the agent fails fast with a re-approve pointer and the UI runs
the consent dialog again, showing what would run now.

Bindings live profile-side (`profiles/<id>/agent-bindings.json`):
`{ "<projectId>/<slug>": { consentHash, auth } }`, where `auth` is either
`{ mode: "local" }` (the machine's CLI login) or `{ mode: "api-key" }`
with the key encrypted at rest via safeStorage — the same pattern as the
profile agent roster. Approval binds the profile's matching existing auth
for the harness.

`source: "secret"` needs **no personal consent**: the key comes from a
project secret (ADR 0033), so nothing personal is spent and the secret's
presence *is* the authorization — whoever set it authorized this project
to use it. This is also the mode that works headlessly on a shared or
remote server, where "the user's own login" doesn't exist. The desktop
resolves the secret through core's SecretsService at provider build time;
a missing secret fails the turn naming it.

Every blocked state — unconsented, stale, invalid file, unsupported kind,
missing secret — resolves to a registered agent whose provider **fails
fast** with an actionable error event. A turn on a blocked agent errors
clearly; it never hangs and never dies as an opaque "not configured".

### The `acp` kind is reserved, deliberately

ACP (the Agent Client Protocol) is the designed transport for agents the
project brings that are *not* one of the host's built-in harnesses — a
local command speaking ACP over stdio, or a remote endpoint (the
remote-Catamorphic-server agent story rides this). The kind validates
today and resolves to a clear "not built yet" registry entry, so
definitions authored now stay valid when the harness lands (TODO: "ACP
harness").

## Consequences

- An agent is now shareable by committing two files; collaborators see it
  in the picker immediately, approve once, and re-approve only when its
  sensitive definition actually changes.
- The consent hash makes the threat model explicit: collaborator-authored
  code never touches personal credentials without a per-user,
  per-definition-state grant. `secret` mode gives teams a consent-free
  path whose blast radius is a key the project owner chose to share.
- The e2e suite gets a definable fake: kind `"e2e-fake"` is accepted only
  under `CATAMORPHIC_E2E_FAKE_AGENT=1` (the same seam family as the
  pick-folder stub) and auto-consents, since it touches no credentials.
- v1 cuts, tracked for follow-up: `connections` is informational (shown,
  not enforced); a secret's *value* change is picked up on provider
  rebuild, not watched; approval binds existing profile auth rather than
  running the full agent-setup wizard.
