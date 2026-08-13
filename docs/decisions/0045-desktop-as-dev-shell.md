# 0045 — The desktop is a dev shell: harness fidelity, worktrees, diffs, and PRs

- **Status:** Accepted
- **Date:** 2026-08-13
- **Builds on:** 0043 (general-purpose projects), 0044 (checkpoints + remote sync)
- **Refines:** 0044's worktree stance

## Context

Engineers should be able to import a real monorepo and use Catamorphic
Desktop as their daily driver for development — an *awesome shell* for
Claude Code (or whichever harness they run), not a wrapper that dilutes
it. That means three things the app didn't do: honor the conventions dev
repos already carry (CLAUDE.md, `.claude/` skills/agents/settings), speak
to engineers like engineers, and expose the git surfaces a developer
actually reviews with — diffs, worktrees, and pull requests. All of it
must stay ignorable by non-technical users: a scary tab is one ⌘W away,
and every sidebar section is removable config.

## Decision

### 1. Harness fidelity

The claude-code harness now rides the SDK's `claude_code` preset system
prompt with the host's paragraphs **appended** (previously a raw string
*replaced* the preset — sessions lost Claude Code's own doctrine), and
loads `settingSources: ["user", "project", "local"]`, so a repo's
CLAUDE.md, `.claude/` skills, agents, commands, and settings all work
exactly as in the CLI. "User" resolves inside the agent's private
`CLAUDE_CONFIG_DIR`, so per-agent isolation is unchanged. This also
closes the persona-parity gap from the 0044 TODO.

### 2. Calibrated fluency

The workspace playbook (all harnesses) now opens by telling the agent its
users range from non-programmers to professional engineers, and to
calibrate from how the user talks and what the project holds — never
simplifying away technical substance for an engineer, never leading with
git vocabulary for a non-technical user. Plain-language reporting is a
*mode*, not the personality.

### 3. Worktrees are first-class citizens (not automatic)

0044's rejection of *worktree-per-session* stands — sessions share the
project folder because live visibility is the product. What changes:
worktrees that users or agents create deliberately (parallel work,
experiments, Claude Code's own worktree features) are recognized
everywhere. The git read layer discovers every worktree; the sidebar
shows each one's changes (plus its branch-vs-main delta); diffs open per
worktree. Prompts teach the one sharp edge: **gitignored files don't
follow a new worktree** — agents are told to copy the relevant `.env` /
local config from the main folder before working there, and to say so.

### 4. Git read surfaces ride the system git binary

Worktree listing, status, and three-dot diffs shell out to `git`
(`git-view.ts`) rather than reimplementing them on isomorphic-git —
worktrees and merge-bases are exactly where a reimplementation quietly
lies. The *write* path (checkpoints, sync) stays isomorphic-git and works
without system git; when git is absent, the read surfaces report
unavailable and the sidebar shows one quiet line. Diff *content* is
served as before/after text and rendered read-only in Monaco's
DiffEditor (a new `diff` workspace tab kind); a PR file renders its
unified patch directly.

### 5. PRs through the CodeHost seam

`CodeHost` gains optional `listPullRequests` / `pullRequestFiles`
capabilities (GitHub implements them via the REST API; any future host
implements the same shapes). The sidebar's Pull Requests section lists
open PRs, expands to a changed-file tree, and opens per-file diff tabs —
the GitHub-extension-in-VSCode flow, provider-neutral by construction.

### 6. The sidebar is the dev cockpit, and it layers

Two new built-in section types: `git` ("Changes") and `prs`
("Pull Requests", collapsed by default). Sidebar config becomes layered,
first match wins:

1. `profiles/<id>/sidebar-projects/<projectId>.js` — this user's local
   view of this project
2. `<project>/.catamorphic/sidebar.js` — the project's shared default,
   git-tracked, travels to every collaborator (opt-in; never seeded)
3. `profiles/<id>/sidebar.js` — the user's global config
4. built-in defaults

A "Customize sidebar" affordance in the sidebar footer opens a normal
agent chat pre-seeded with the request — discovery only; agents could
always edit the config. Right-click on any sidebar row opens the same
data-driven ⋯ menu. An invalid layer file falls back to defaults with the
error logged (never silently to the next layer).

## Consequences

- An imported dev repo behaves like home: its agent conventions load,
  its PRs and diffs are one sidebar click away, and worktrees show up
  instead of being invisible side directories.
- Dev surfaces degrade quietly for non-technical users (empty sections,
  removable via config, closable tabs) instead of being hidden behind a
  mode switch — one app, calibrated by content.
- System git becomes a soft dependency for the read surfaces only.
- PR review depth (comments, approvals, merging) is future work on the
  same CodeHost seam, alongside the collaboration slice's review mode.
