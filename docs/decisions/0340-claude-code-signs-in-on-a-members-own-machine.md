# 0340 — Claude Code signs in on a member's own machine; one harness sign-in for both

- **Status:** Accepted (amends [0213](0213-codex-signs-in-on-a-members-own-machine.md) and [0199](0199-subscription-sign-ins-stay-on-the-machine.md))
- **Date:** 2026-11-20

## Context

ADR 0213 took Claude Code sign-ins off servers and workers, saying
Anthropic suspends accounts used from cloud addresses and that its terms
frame a subscription as one person on their own machine. The suspension
claim could be neither verified nor refuted from official sources.
Anthropic's Claude Code legal page
(<https://code.claude.com/docs/en/legal-and-compliance>, read 2026-11-20)
forbids third-party developers from offering Claude.ai login in their own
applications, routing requests through plan credentials on behalf of
users, and collecting, storing or intermediating Claude.ai credentials or
session tokens: "sign-in to a Claude account must complete through
Anthropic's own flow". It then says this does not "prevent an end user
from signing in to the unmodified Claude Code binary with their own Claude
subscription, including where a platform hosts Claude Code", provided the
binary is unmodified with none of its authentication methods removed,
disabled or restricted; each end user authenticates with their own
credentials and is billed directly; nobody pays for, resells or
intermediates usage; and plan limits assume ordinary, individual usage.
Meanwhile the sign-in code was written for Codex alone.

## Decision

**Claude Code signs in on a member's own machine, as Codex does.** The
machine's own unmodified `claude` runs its own login (`claude auth login`)
there, into a home for that member on the machine's disk. The app shows
the link it printed; the member completes Anthropic's own flow in their
own browser and pastes the code that page gives them, which the machine
writes to the login as its one line of input. Work never reads, copies,
uploads, stores or forwards the credential. The pasted code travels
sealed (ADR 0207) and is never logged, stored or repeated in an answer.
Model traffic goes straight from the CLI to Anthropic, never through
Work's model gateway, and a chat on a sign-in is started without any
variable that names another credential or endpoint (`ANTHROPIC_API_KEY`,
`ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_OAUTH_TOKEN`).
Work restricts none of the binary's sign-in methods: `work worker sign-in
claude-code` passes any login arguments through.

**One person's account per machine, across both harnesses.** A machine
holds the sign-ins of one person at most; that person may hold both a
Claude Code and a Codex sign-in there. The sign-in lives on one machine,
so it needs a machine that persists: a machine rule's each-member machine,
or a hand-enrolled worker whose access names only that person. A machine
created on demand and destroyed when idle loses it. Cloud sandbox
providers still refuse sign-ins, and 0199's placement checks stand.

**One harness sign-in.** `SIGN_IN_SPECS` (`@catamorphic/sandbox`) says how
each harness differs: its home variable, the file a completed login
leaves, its login command, and whether the login prints a one-time code
or waits for one. The sealed operation `machine.harnessSignIn` replaces
`machine.codexSignIn` (worker protocol 4; older workers are answered 426),
member routes name the harness
(`/api/work/me/machines/:id/:harness/sign-in`), and a machine reports a
state per harness.

This is Work's reading of a public page, not an approval by Anthropic.
Enforcement is at Anthropic's discretion, and whether a given use is
allowed under its terms remains the operator's responsibility.

Considered and rejected: a sign-in flow of Work's own (offering Claude
login in our application, and intermediating its tokens, is what the page
forbids); copying a sign-in from a member's computer (ADR 0184, the
same); a long-lived token the member hands Work (Work would store a
credential); a second mechanism beside Codex's (two code paths for one
rule).

## Consequences

Members run Claude Code on their own plan on a machine of their own,
signed in from the app. The machine needs `claude` on its `PATH`; Work
carries no copy of it. On macOS Claude Code keeps its sign-in in the
Keychain rather than its home, so a Mac machine reports that the login
left no sign-in: these sign-ins are for Linux machines. A sandbox whose
harness runs as another user than the one that owns the home (a non-root
image user, or commands run apart, ADR 0332) cannot read it, as before
for Codex. Login attempts remain a machine process's working state.
