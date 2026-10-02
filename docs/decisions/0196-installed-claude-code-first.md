# 0196: The person's own Claude Code runs first; pins move by pull request

- **Status:** Accepted
- **Date:** 2026-10-02
- **Refines:** 0091

## Context

Work downloaded one integrity-pinned Claude Code executable on first use and
ran it for every chat. Claude Code's model list and behavior come from that
executable, so the pin aged between app releases: models the person saw in
their own terminal were missing in Work. Many people already have Claude Code
installed and kept current by its own updater, and the ~200 MB download
duplicated it. Pins were moved by hand.

## Decision

On the person's machine, Work runs their own Claude Code when it is a native
executable at or above `CLAUDE_CODE_MIN_VERSION`: the CLI release the bundled
Agent SDK ships with, so the protocol the harness relies on (steered input
acknowledgements, model catalog, hooks) is present. Work looks on its own
PATH, the login shell's PATH, and the usual install locations, takes the
newest, and asks each file its version only when the file changes. Only when
none qualifies does it download its pinned copy, exactly as 0091 describes.
JavaScript installs (global npm) are skipped: a Dock-launched app has no Node
on PATH to run them.

An installed Claude Code that is too old is reported in the agent's settings
with an Update action that runs that install's own `claude update`, only when
the person presses it. Work never updates it unasked.

Pins still never float. A scheduled workflow
(`.github/workflows/claude-code-bump.yml`) runs `scripts/claude-code-bump.ts`
daily; when a new SDK is published it opens a pull request moving the SDK, the
minimum version and every platform integrity together, and dispatches CI on it.
A test fails if the three drift apart. Merging stays a human decision.

Considered: downloading the newest Claude Code at runtime. That drops the
integrity pin, and the SDK bundled in the app only changes with a release, so a
CLI far ahead of it is untested. Sandboxes and the Work server keep the pinned
copy; the person's machine is the only place an install is looked for.

## Consequences

A person with a current install gets current models with no download, and
Work's copy keeps working for everyone else. Work's chats may run a newer CLI
than CI tested; the version floor keeps them from running an older one. Tests
never use the host's install. The bump pull request needs a review and the
native Claude Code tests to merge.
