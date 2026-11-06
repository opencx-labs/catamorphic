# 0199 — Subscription sign-ins stay on the machine they were made on

- **Status:** Accepted (amended by [0213](0213-codex-signs-in-on-a-members-own-machine.md): Claude subscriptions stay on members' computers; Codex signs in from the app on a member's own machine, one person per machine)
- **Date:** 2026-10-02
- **Supersedes:** the login half of [0184](0184-personal-credentials-reach-a-members-own-sessions.md) (personal files stay)

## Context

ADR 0184 copied a member's Claude Code and Codex logins from their
computer to the Work server, sealed them in the vault, and wrote them into
sandboxes. Anthropic's terms for Claude Code (Legal and compliance,
"Authentication and credential use") forbid exactly this: third parties may
not offer Claude.ai sign-in in their own apps, route requests through
Free, Pro or Max credentials on behalf of others, or "collect, store, or
intermediate Claude.ai credentials or session tokens"; sign-in must
complete through Anthropic's own flow. The same terms allow a person to
sign in to the unmodified Claude Code binary with their own subscription,
including where a platform hosts it, and allow API keys provisioned by
their owner. Where a machine is (a cloud VM or a home server) is not the
question; whose sign-in it is, who it serves, and whether Work handled it
are.

## Decision

**A sign-in is a fact about a machine.** A member signs in to a harness
with the harness's own flow on the machine that will run their work, into
a per-member harness home in that machine's own storage: their computer's
existing login, or `work worker sign-in <harness> --member <id>` on a
worker, which runs the CLI's own login there (`claude /login` with
`CLAUDE_CONFIG_DIR`, `codex login` with `CODEX_HOME`). Work never reads,
copies, uploads, stores or forwards the credential. A machine reports only
which members are signed in, as capabilities on its offer
(`sign-in:<harness>:<member>`), never a value.

**Placement and permission, no special case.** A registered agent with
`signIn: "claude-code" | "codex"` (the built-in Claude Code and Codex
agents, or a committed definition with `credentials: { source:
"personal" }`) runs a chat only when all of this holds, checked again on
every turn:

- placement found a machine reporting the chat owner's sign-in for that
  harness, and takes no other;
- the machine isolates that member: a microsandbox VM, a worker whose
  access names only them, or a local-process machine whose operator
  accepts it (`WORK_PERSONAL_CREDENTIALS=accept`);
- the chat's Environment allows it (`"personalCredentials": true`);
- the owner wrote everything the turn answers: its input, every message
  steered into it, and for a continuation the turn it continues. Anyone
  else's message to such a turn waits for a turn of its own, and a queued
  message can be edited only by its author (0184's rule, made whole). A
  chat held by another host (a member's desktop) runs only on that host's
  owner's credentials, so of the messages delivered to it through the
  server's mailbox only the owner's start turns; the rest arrive to read.

The sandbox mounts that member's harness home from the machine's own disk
(`CreateSandboxOpts.signIns`; a read-write bind mount, so the CLI's own
token refresh keeps working), and nothing leaves the machine. Cloud
sandbox providers refuse sign-ins. Admission refuses with the reason and
the fix, so revoking access, a rule or the flag stops it on the next turn.

**Everything else uses keys.** A company server's agents use model
connections through the gateway (ADR 0180), or a member's own API key
stored as their personal connection, billed to that key's owner.

## Consequences

`PUT /projects/:id/personal-environment` keeps files and refuses logins;
the vault rows, delivery, renewal and "Open Work so it can refresh it"
paths for logins are removed. A cloud company brain runs on keys; a home
server or a member's own worker can run their subscription. Codex ChatGPT
sign-ins follow the same rule. Whether a given use is allowed under
Anthropic's or OpenAI's terms remains the operator's responsibility; Work
only refuses to be the party that carries a consumer credential.

The mounted home holds the CLI's refresh token, and code the agent runs in
that sandbox can read it, as on a person's own computer: a project's
committed hooks or a prompt injection could send it out. A member should
allow their sign-in only in projects whose code they would run on their
own machine, and an Environment that admits sign-ins should restrict
egress. On macOS, Claude Code keeps its login in the Keychain, so a Mac
sign-in serves only local-process chats on that Mac.
