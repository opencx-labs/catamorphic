# 0275 — A resumed Claude Code keeps its sign-in

- **Status:** Accepted
- **Date:** 2026-10-22
- **Amends:** [0198](0198-agent-runners-run-harnesses-beside-their-workspace.md), [0228](0228-a-sign-in-that-can-still-refresh-is-retried.md), [0269](0269-a-turn-that-failed-on-sign-in-while-away-runs-again-on-return.md)

## Context

People came back to Work after a few hours and the first message in a chat
failed with "OAuth access token has expired", asking them to sign in to
Claude again. Their sign-in was fine: its refresh token had weeks left, and
the same login kept working in a terminal. ADRs 0228 and 0269 read the
missing refresh as contention between Claude Code processes and added
retries, which also failed.

Claude Code's transcript lives with Work (0198, the Agent SDK's
`SessionStore`), so resuming a thread makes the SDK write it to a temporary
config home (`claude-resume-*`) and start the CLI there. The SDK copies the
sign-in into that home **without its refresh token**, and the CLI reads
only the copy. Once the copied access token expired (eight hours) or
another Claude Code renewed the sign-in, the resumed CLI sent a dead token,
never tried a refresh, and failed. A warm CLI started that way (0222)
failed the same way when its token ran out. Every failure that left a
record (the debug logs of 0228's retries) ran from a `claude-resume-*` home
with no refresh attempt, and the pinned CLI reproduces it. On macOS an
agent signed in on a home of its own (the desktop's `account` agents) fared
worse: the SDK found no credentials file to copy, so its resumed CLI had
none at all.

## Decision

**A CLI that runs on a sign-in keeps the sign-in's own store.** Every
Claude Code CLI Work starts on a sign-in (a chat's, and the model and
command probes) gets `CLAUDE_SECURESTORAGE_CONFIG_DIR` set to the home
whose sign-in it would use on a fresh thread: a member's `sign_in` home
always; on the host, the store or `CLAUDE_CONFIG_DIR` the attempt names,
else the ones the host itself was started with, else the empty string,
which is the default home (the plain `Claude Code-credentials` Keychain
item, or `~/.claude/.credentials.json`). The CLI takes its Keychain item,
its credentials file and the lock it refreshes under from this setting, not
from its config home. A resumed CLI therefore refreshes the real sign-in in
place, under the lock every Claude Code on the machine shares, and takes up
a token another process renewed. The SDK's stripped copy stays in the
temporary home, unread. The SDK already does this itself on Windows.

Considered and rejected:

- **Answering the CLI's token-refresh requests from Work** (the SDK's
  host refresh hook, as the Claude app does). The CLI honors it only for
  Anthropic's own clients, and it would put Work between a person and their
  credential, which 0199 rules out.
- **Resuming from the CLI's own `projects` directory**, as t3 code does
  (it uses no session store). That drops 0198's portable threads.
- **Refreshing the sign-in before each launch.** It cannot help a CLI that
  outlives its token, and Work would be refreshing a credential it must not
  handle.

## Consequences

A chat resumed after any break signs in like a terminal session, so 0228's
quiet retry and 0269's rerun on return are left for genuine contention and
network failures. Gateway access is unchanged, since it uses no sign-in. A
member's sign-in home on a machine of their own (`sign_in`) now refreshes
from resumed threads too, as 0199 intended.

Every CLI hands the setting to what it runs. A Work started from a chat's
shell inherits it, which is why the attempt's own names come first; a
`claude` run from an agent's shell uses the chat's sign-in unless it sets
the store too. Like `CLAUDE_CONFIG_DIR`, a sandbox secret may not set it.
The SDK still writes its stripped copy to the temporary home, which a
process that dies without cleanup leaves behind. A native test drives the
pinned CLI through a resumed thread whose token another Claude Code
renewed.
