# 0213 — Codex signs in on a member's own machine; Claude subscriptions stay on their computer

- **Status:** Accepted
- **Date:** 2026-10-06
- **Amends:** [0199](0199-subscription-sign-ins-stay-on-the-machine.md)

## Context

ADR 0199 let a member sign in to Claude Code or Codex on any machine that
isolates them, from a terminal on that machine. Two things changed the
picture. Anthropic suspends accounts it sees used from cloud addresses or
by several people, and Claude Code's subscription terms frame use as one
person on their own machine; a ban costs the member their account and a
support case. And a terminal on a worker is not where members are: they
are in the Work app, and a datacenter machine has no browser for a login.

OpenAI documents Codex on remote machines (its own Remote SSH runs the
Codex app server on the remote host with that host's own `auth.json`),
offers a device-code login for machines without a browser, and meters a
ChatGPT plan by account, shared across every surface that account uses. A
machine signed in to several people's accounts would look, from one
address, like a shared or resold account however well its sandboxes are
isolated.

## Decision

**Claude Code subscriptions run only on a member's own computer**, in the
Work app, as they always could. Servers and workers never hold a Claude
sign-in: the built-in Claude Code agent on a server is gone, a committed
Claude Code definition with personal credentials is not offered there, and
`work worker sign-in claude-code` refuses with this reason. Claude Code on
a server runs with an API key through the organization's model connection.

**Codex signs in on a member's own machine, from the app.** A member's
own machine is a worker whose access names only them, or a single
server's own machine whose operator set `WORK_PERSONAL_CREDENTIALS=accept`
(a single person's server). In the app's Remote environment, the member
picks a machine and the machine runs `codex login --device-auth` into a
fresh home of its own; the app shows Codex's link and one-time code, the
member approves in their own browser, and the completed login takes the
member's place on that machine. The token is issued to Codex there and
never leaves it. Requests and answers travel as sealed operations (ADR
0207), so the one-time code never rests on the control plane in the
clear. A login that is pending, denied, cancelled or expired never
replaces the member's existing sign-in. Members sign out the same way.

**One person's account per machine.** A machine holds Codex sign-ins of
one person at most: a second person's login is refused, from the app and
from `work worker sign-in`. Placement runs a sign-in chat only where the
host marks the binding `ownSignIns` (a machine serving only its owner, or
the single server's own machine), on top of 0199's checks.

Considered and rejected: routing Claude traffic through members' home or
office addresses (it hides where work runs from the provider, which is
what the terms object to); Sign in with ChatGPT for Codex through Work
(possible later; the device code keeps the token on the machine without
Work ever handling it).

## Consequences

Members get Codex on their subscription on a machine of their own without
a terminal; administrators give each such member a machine (a machine
rule per member, ADR 0205). A shared machine runs Codex only on API keys.
Device-code sign-in must be enabled in the member's ChatGPT security
settings (and allowed by a workspace administrator for business plans);
the app says so when Codex refuses. Login attempts are a machine
process's working state: a machine that restarts forgets them and the
member starts again. Whether a given use is allowed under OpenAI's terms
remains the operator's responsibility.
