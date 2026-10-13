# 0226 — Agent terminals mark commands in bash too

- **Status:** Accepted (amends [0223](0223-an-agent-terminal-lives-as-long-as-its-command.md))
- **Date:** 2026-10-14

## Context

Agent terminals learn exactly when a command starts and ends from OSC 133
markers. Only zsh had them. In any other shell, a background command ended
when one 500 ms sample found the terminal's foreground process back at the
shell, as the shell is for a moment between the steps of
`sleep 5; for …; do …; sleep 1; done`.

Since ADR 0223 an ended command's terminal is killed. So on bash (Linux
by default) a running command could be reported finished and killed at
a random moment. This was the Linux CI flake in `app.e2e.ts`'s
"news from a background command", which #222 had loosened the test to
accept.

## Decision

**bash gets the same markers as zsh.**
- An agent bash starts non-login, with an init file Work writes:
  `bash --init-file <shim>`. A login bash reads no init file, so the shim
  reads the login files itself: `/etc/profile`, then the first of
  `~/.bash_profile`, `~/.bash_login` and `~/.profile`.
- It then puts Work's command shims first on `PATH`.
- `PS0` prints `133;C` as a command starts (bash 4.4 and later).
- The first `PROMPT_COMMAND` entry prints `133;D;<exit>`. A person's own
  `PROMPT_COMMAND` still runs after it, whether a string or an array.
- The person's own terminals stay untouched, as before.

**A guessed end must last.** A shell without markers (fish, sh, bash
before 4.4) ends its command only once the terminal has stayed idle for a
second across samples, not on one idle sample.

Rejected:
- Wrapping each command in its own markers. They would show in the
  terminal's echo, and fish would still not be covered.
- Setting `SHELL=/bin/zsh` on Linux CI. That would hide the bug instead of
  fixing it.

## Consequences

Background commands, `run_terminal` exit codes and terminal busy state are
exact in bash, as in zsh. Linux CI keeps exercising bash. A marker-less
shell reports a command's end about a second later than it did.
