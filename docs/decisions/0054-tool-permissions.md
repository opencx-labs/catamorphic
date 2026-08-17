# 0054 — Tool permissions: layered policies that intersect, at the connection and the agent

- **Status:** Accepted
- **Date:** 2026-08-18
- **Builds on:** 0046/0047 (capability providers), 0050 (project agents,
  consent before credentials), 0052 (agents ask for connectors), 0053
  (identity scope, remote hosts)

## Context

Connectors gave agents MCP tools with no gate: whatever a connection
exposed, every agent could call — read a channel and post to it alike.
Cowork and Claude Code both put a per-tool switch and an "ask first"
between the model and a connector; we had neither, and the first Slack
session showed it (the model asked for permission in prose because
nothing else would).

The requirement arrived with a second, larger one: soon agents and MCP
servers will also be defined on **remote instances** — a company runs its
brain as a Catamorphic project, its backend serves agents and unified MCP
surfaces (many connectors and workflows behind one server) to project
members behind its own auth. Whatever we build for "may this agent call
this tool" has to hold when the agent is not the user's own, and when the
credential is not the user's own.

## Decision

**1. One policy shape, harness-neutral** (`@catamorphic/sandbox`
`tool-policy.ts`): `{ default?: allow|ask|deny|auto, tools?: {name →
allow|ask|deny} }`. `auto` reads the tool's spec annotations — a
`readOnlyHint` tool runs, anything else asks. This is the same vocabulary
as Claude Code's `mcp__<server>__<tool>` allow/ask/deny rules, so a policy
round-trips into a `.claude/settings.json` if we ever want it to.

**2. Two scopes, and they intersect.**
- **Connection (profile) scope** — the credential owner's ceiling. Stored
  on the connection (`toolPolicy`), edited in Connectors → Permissions.
- **Agent scope** — the agent's own narrowing. Stored on the profile
  agent (`toolPolicies` by connection id) or, for committed/remote
  definitions, in the definition (`toolPolicies` by connector name).

Resolution is the **strictest answer across layers** (deny < ask < allow),
computed per tool at call time. No precedence table: an agent cannot lift
what the connection owner restricted, and a connection cannot force a
tool onto an agent that excluded it. This is what makes the remote case
fall out: a hosting backend defines the agent (its layer), a member's own
connection policy is still a ceiling (their layer), and neither side can
be widened by the other. It is also why agent-level `toolPolicies` do NOT
enter the consent hash of ADR 0050 — a change can only narrow.

**3. Enforcement lives where the tool call is made.**
- ai-sdk harness: a gate around every `mcp__*` execute (own MCP client).
- Claude Code: policed servers lose the server-wide allowlist entry; each
  tool routes through the SDK's `canUseTool`, where the policy decides.
- Codex: no per-call channel exists (approvals off, no host callback), so
  the policy applies coarsely at spawn — `deny` AND `ask` tools go to
  `mcp_servers.<id>.disabled_tools`. Ask fails closed; the editor says so.
- Policies are read through a **getter** on every call, so an edit — or an
  "Always allow" mid-turn — applies to the next call without rebuilding
  the provider (which drops in-memory sessions). They are excluded from
  the provider cache key for the same reason.

**4. `ask` is a host prompt**, like elicitation: `WorkspaceBridge.
toolPermission` → the front window's consent modal (agent, tool, server,
arguments, read-only/destructive hint) → Allow once / Always allow / Deny.
"Always allow" writes an allow rule onto the **connection** policy (the
ceiling, so every agent benefits) and the asking harness remembers it for
its lifetime. No window → deny; the model reads the reason and moves on.
A remote host embeds Catamorphic and would answer the same prompt in its
own UI — the bridge is the seam.

**5. Defaults are `auto`.** Nothing to configure for the common case:
read-only tools just work, mutating ones ask once, and "Always allow" is
one click. Tool rosters (with annotations) are cached on the connection
whenever it is probed or authorized, so `auto` resolves for harnesses
that cannot see annotations at call time.

**6. The project's workflow tools are a policed server too.** The
per-session `catamorphic` server (a project's `ai.tool-call` workflows) is
open by default; an agent's `toolPolicies.catamorphic` confines it — a
default of Ask/Off plus per-workflow rules — which is how a host will
control which workflows a remote agent may run and whether members must
confirm.

**7. Agent-layer semantics.** An agent policy's unset default means "no
opinion" (allow — the intersection is the connection's ceiling); a
connection policy's unset default means `auto`. Without that asymmetry an
agent that pinned one tool would narrow every other tool of the
connection to "ask". The editor therefore offers the agent Inherit / Ask /
Off only — the only moves that can change the answer.

## Consequences

- Connectors modal: each installed connection has a Permissions editor
  (default + per-tool, showing the effective answer). Codex users see the
  ask-fails-closed caveat there.
- `probeMcpServer` returns tool annotations; the desktop caches them.
- Settings → edit agent has a "Tool access" editor: one row per assigned
  connection (tools from the cached roster, effective answer per tool
  after the ceiling) plus Workflows (the current project's, listed live).
- Deferred: per-session "allow for this chat"; the reverse round-trip
  from `.claude/settings.json` permission rules; the wizard shows no
  policy editor (creation is about getting signed in — edit after).
- Codex remains the weakest harness here until it exposes an approval
  callback; when it does, the same policy layers plug in.
