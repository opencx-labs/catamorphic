# 0197 — Subscription sign-ins stay on the machine they were made on

- **Status:** Accepted
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
existing login, or `work worker sign-in <harness>` on a worker, which runs
the CLI's own login there. Work never reads, copies, uploads, stores or
forwards the credential. A machine reports only which members are signed
in to which harness (`sign_ins` on its offer), never a value.

**Placement and permission, no special case.** An agent whose definition
says `credentials: { source: "personal" }` runs only:

- on a machine that reports the chat owner's sign-in for its harness;
- where the machine's operator allows sign-ins (`signIns: "allow"` on the
  worker or machine rule, the member's own device by default) and the
  machine isolates that member (their device, a worker whose access names
  only them, or a microsandbox VM), as before;
- in an Environment that allows it (`"personalCredentials": true`);
- for turns the owner authored, never a project chat or another member's
  message (0184's rule, unchanged).

The sandbox mounts that member's harness home from the machine's own disk
(a bind mount, so the CLI's own token refresh keeps working), and nothing
leaves the machine. Admission refuses with the reason and the fix, and every
turn re-admits, so revoking access, a rule or the flag stops it on the next
turn.

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
