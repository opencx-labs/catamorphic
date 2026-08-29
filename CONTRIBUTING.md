# Contributing to Catamorphic

Catamorphic is an issue-first project.

If you do not have write access to the repository, please open a GitHub issue
instead of preparing a pull request. Pull request creation is restricted to
the core team and collaborators with write access.

## Why issues first

AI makes producing a large code change inexpensive, but it does not make that
change inexpensive to review. A pull request can be an exploded, lossy version
of a much smaller idea: hundreds of implementation decisions that obscure the
problem, constraints, and intended outcome.

We would rather review that compact source of intent first. Once an issue is
understood and accepted, a maintainer can give it to an agent with the full
repository context, make the implementation decisions locally, and remain
responsible for the resulting code.

This is not a judgment about whether a contributor used AI. It is a choice
about where review is most valuable and who owns the implementation.

## What makes a useful issue

Please include:

- the problem or opportunity;
- a concrete use case or reproduction;
- the outcome you want, without expanding it into a speculative patch;
- relevant constraints, tradeoffs, screenshots, logs, or links;
- why the change belongs in Catamorphic rather than a host application.

Small examples are welcome when they clarify behavior. Full generated patches
and implementation dumps are not necessary.

Maintainers may close issues that do not fit the project, ask for a narrower
problem statement, or implement an accepted issue differently from its initial
suggestion.

## Core-team pull requests

Pull requests remain the core team's integration and review surface. They
should normally trace back to an accepted issue, design discussion, or explicit
maintainer task. Repository contributors must still follow `AGENTS.md`, the
accepted ADRs, and the required `bun run check` merge gate.
