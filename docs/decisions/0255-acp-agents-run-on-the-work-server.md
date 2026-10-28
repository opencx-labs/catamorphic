# 0255 — ACP agents run on the Work server, their model through the gateway

- **Status:** Accepted (builds on 0180, 0198, 0241; amends 0212: a renewed grant replaces the old one once the sandbox holds it; model grant lifetime amended by [0293](0293-model-grants-end-with-their-turn-attempt.md))
- **Date:** 2026-10-18

## Context

ADR 0241 runs ACP agents (Hermes, OpenCode, any agent that speaks the
Agent Client Protocol) on the desktop, on their own configuration and
sign-in, and left "ACP agents on the Work server" and "model choice
through ACP" open. Teams that review pull requests on a server want an
open agent such as OpenCode on an open-weight model, in a sandbox that
holds no credentials. Claude Code and Codex already run that way (ADR
0180): their CLI runs in the chat's sandbox and reaches its model through
the gateway with the session's grant. An ACP agent cannot follow them
exactly: it reads its key once when it starts, while a sandbox grant is
renewed every 20 minutes and the old one revoked at once (ADR 0212), and
review agents run longer than that.

## Decision

**A committed ACP agent runs in its chat's sandbox.** On a Work server a
project agent `{ "kind": "acp", "acp": { "command": ["opencode", "acp"] },
"credentials": { "source": "connection", "connection": "<alias>" } }` is
served like a `claude-code` or `codex` one: placement `sandbox`, the
bundled runner's ACP adapter, its harness `acp:<agent id>` so a chat stays
with its agent (the runner resolves a harness by its family before the
colon). The command comes from the Environment's image. The sandbox is
the boundary, so on a server the command needs no member's approval. An
ACP agent on a server runs only on a model connection: it has no sign-in
of its own there.

**Its model is the gateway on loopback.** With a model connection the
adapter serves the connection's API on the sandbox's loopback for the
attempt, under a key of its own that opens only that endpoint. Each
request goes on to the gateway with the grant read from its file just
before, and once more after a refusal in case it was renewed in between;
paths and answers pass unchanged, answers streamed, and a body is read
whole first so the retry can send it again. An agent that stops waiting
stops the call upstream. A renewal now issues the new grants, writes them
into the sandbox, and only then revokes the old ones (ADR 0212 revoked
them at once), so a harness reading its grant file between the two never
holds a dead grant. The agent learns where its model is three ways, all
of them used:

- ACP's `providers/set` (unstable), when the agent advertises
  `providers`: every provider it lists that speaks the connection's API is
  pointed at the endpoint, with the key in its headers, and every optional
  one that speaks another API is turned off (`providers/disable`). An
  agent that fails at this keeps the variables, with a warning.
- Environment variables: `WORK_MODEL_API`, `WORK_MODEL_BASE_URL`,
  `WORK_MODEL_API_KEY` and `WORK_MODEL` (the definition's model), which an
  agent's own configuration can name (OpenCode's `{env:WORK_MODEL_BASE_URL}`),
  and the API family's conventional `OPENAI_BASE_URL` and `OPENAI_API_KEY`
  (or `ANTHROPIC_*`), which many agents read unasked.
- The definition's `model` chosen through the session's model option
  (`session/set_config_option`) when the agent offers one, matched by id,
  name, or the one value ending in `/<model>`; when it offers models but
  not this one, the turn says which it offers.

Processes the agent starts inherit the variables, so an agent that runs
more agents (a review harness fanning out reviewers) reaches the same
endpoint while its attempt runs. The endpoint closes with the attempt, so
anything still running from an interrupted or superseded turn loses that
endpoint, even a process outside the agent's process group. Independently, the
control-plane gateway checks the grant's exact turn, attempt and live lease on
each new request (ADR 0293), including requests that bypass this loopback
endpoint. Already admitted upstream calls may finish; immediate cancellation
of them across replicas is not promised.

Considered: a key helper per agent, as Claude Code's `apiKeyHelper` and
Codex's provider command are (most ACP agents have none); handing the
grant itself to the agent (it would stop working at the first renewal);
and a loopback gateway shared by every harness in the sandbox (the
others already read the grant per request; the endpoint lives and dies
with the attempt that needs it).

## Consequences

OpenCode, Hermes or any ACP agent can run unattended on review machines,
on whatever model connection the Environment binds, with the key and the
provider policy (ADR 0256) on the control plane. The loopback key is in
the agent's environment, so any process in the sandbox can use the
endpoint while the attempt runs, as any process there can read the grant
file; that is the sandbox's trust, unchanged. "The sandbox is the
boundary" holds where the machine isolates: on a trusted local-process
worker, or a member's own machine, a committed ACP command runs on that
machine itself, as a committed Claude Code hook would. An agent that ignores all
three channels runs on whatever its own configuration says, and in a
restricted Environment has no other route out. A sandbox replaced for a new base (ADR 0257) takes the agent's saved
sessions with it, so the next turn's reopen fails: an agent that answers
that with a plain internal error, as OpenCode does, and offers
`session/list` is judged by its list, and a session it no longer lists is
gone (ADR 0245), so the turn goes on in a new one, handed the
conversation. Still open from ADR 0241:
the `acp.endpoint` transport, streaming an agent's plans and usage, and a
warm process between turns.
