# 0243 — Claude accounts take turns: Work moves to the next one at 85%

- **Status:** Accepted (builds on [0199](0199-subscription-sign-ins-stay-on-the-machine.md), [0222](0222-desktop-harnesses-stay-warm-between-turns.md), [0228](0228-a-sign-in-that-can-still-refresh-is-retried.md))
- **Date:** 2026-10-17

## Context

People with more than one Claude plan (a personal Max and a work Team
seat, two Max accounts) hit one account's 5-hour or weekly limit and
then have to run `/login` in a terminal, or make a second agent on a
separate account and move their chats to it. A Claude Code agent signs
in one way only: the machine's login, its own account home, or a key.
Nothing in Work knows how close an account is to its limit.

## Decision

**A roster of Claude accounts, with no settings.** Settings, Agents,
Claude accounts lists the machine's own Claude Code login (when there is
one) and every account signed in from Work, each with its plan and its
5-hour and weekly usage. The only actions are signing in and signing
out. Every rule is fixed in `apps/desktop/src/main/server/claude-accounts.ts`:

- Work moves to another account when the one in use reaches **85%** of
  its 5-hour or weekly limit, whichever is higher.
- It stays on the account in use while that account is under 85%. When
  it is not, it takes the first account under 85%, in roster order (the
  machine's login first, then accounts in the order they signed in).
  When every account is at 85% or more, it takes the least used one.
- An account a turn was rate limited on rests for 5 minutes, so the
  turn's automatic retry (core's transient backoff) runs on the next
  account. An account a turn was turned away on as signed out rests
  until Claude Code reports it signed in again.
- Usage is what `/usage` shows, asked of Claude Code itself
  (`usage` over the SDK's control channel), once after each turn on an
  account (at most every 30 s) and while Settings shows the roster. A
  turn never waits for it, except the first on an account Work has no
  reading for.

**Sign-ins stay Claude Code's (0199).** "Sign in to a Claude account"
runs `claude auth login --claudeai` in a new home under `agent-homes/`
(`CLAUDE_CONFIG_DIR`). Its `BROWSER` is a two-line script that hands the
sign-in page to Work, which opens it in a browser tab; the CLI serves its
own callback, stores its own tokens and exits. Work reads the account's
email and plan from the home's `.claude.json`, never a credential.
Signing out runs `claude auth logout` there and deletes the home.

Claude Code agents on **this machine's login** (`auth: "local"`) use the
roster when it has an account. Each attempt runs with the chosen
account's `CLAUDE_CONFIG_DIR`, or none for the machine's login. Each
account home links the person's `settings.json`, `CLAUDE.md`, agents,
commands, skills, hooks, output styles and plugins from `~/.claude`, so
an account change does not change how the agent behaves. A switch lands
between turns: the next attempt starts a new CLI (its environment
changed, 0222) and resumes the same native thread, which lives in
Work's session log, not in the account. Agents on their own account or
a key are untouched. With no account signed in from Work, nothing is
read and nothing changes.

The turn that switches says so on its activity line ("Using
b@example.com: a@example.com is at 87% of its 5-hour limit"), and
Settings names the last switch. Agents read the roster and start a
sign-in with the `claude_accounts` workspace tool; the palette has
"Sign in to a Claude account…".

Alternatives considered:

- **Work's own OAuth with tokens handed over in `CLAUDE_CODE_OAUTH_TOKEN`**
  (it keeps `~/.claude` as the only home): Work would store and forward
  Claude.ai tokens, which 0199 and Anthropic's terms rule out.
- **A loopback proxy in front of the API** (Companion's design): it can
  switch within a turn on a 429, but it intermediates every request
  with the person's tokens, the same objection.
- **Thresholds, order and per-agent opt-in as settings**: rejected; the
  roster is meant to work without being understood.

## Consequences

- A chat that switches loses its prompt cache once (caches belong to an
  account), and starts one new CLI.
- A limit reached in the middle of a turn after tools ran is not
  retried (it is not `retrySafe`); the next turn runs on another
  account. The 85% rule exists so that this is rare.
- What each home keeps on its own: `.claude.json` (user-scope MCP
  servers, trust, onboarding) and auto-memory. A tool that rewrites a
  linked file by replacing it unlinks it in that home.
- Pooling several plans is the person's choice of their own accounts;
  Work does not share accounts between people or machines.
- Usage rides an SDK call marked experimental; when it changes, the
  roster shows "Usage unavailable" and switches on rate limits alone.
