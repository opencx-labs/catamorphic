# 0115: Native review conversation

- **Status:** Accepted
- **Date:** 2026-09-10

## Context

Comment bodies with external reply links did not provide a conversation experience.
The user requested Linear-inspired threads separate from the PR description.

## Decision

Discussion owns a scrolling thread list and a persistent comment composer.
Inline comments retain their GitHub parent, diff excerpt, current line and side.
Descriptions remain in Overview. The host injects posting callbacks and shortcut
bindings into the reusable composer; drafts are retained locally by PR and thread.

Posting uses the existing GitHub CLI account through a validated main-process IPC
boundary. The project resolves the repository; the renderer supplies only the PR
number, body, and optional parent comment ID. Bodies travel through stdin rather
than process arguments. Only an explicit submit posts. An uncertain response keeps
the draft and asks the user to check GitHub before retrying. No automatic retries.

This supersedes ADR 0114's external-only reply decision. General comments are GitHub
issue comments; threaded replies are supported for GitHub inline review comments.
We do not invent a parent relationship for general comments or pretend that local
thread resolution, reactions, or review approval updates GitHub.

## Consequences

Users can comment and reply without leaving their review. Failures preserve work;
tests post only to a double-gated local fixture. Native reactions, resolution, and
review submission remain separate capabilities to implement against GitHub.
