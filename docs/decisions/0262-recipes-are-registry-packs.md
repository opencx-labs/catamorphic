# 0262: Recipes are registry packs

- **Status:** Accepted (refines 0126, 0179, 0181)
- **Date:** 2026-10-19

## Context

The pull request review and Slack automations were host skills: every agent
in every project saw them in its skill list, and their files lived as
template strings in `packages/core`, copied out of markdown. A recipe is
something a project adopts once and then owns: it does not belong in every
agent's standing guidance, and its files are better as source than as
strings. The component registry (ADR 0126) already ships installable,
editable source with docs, but only the desktop could serve it, through a
capability agents had to discover before calling.

## Decision

**A recipe is a registry pack.** `packages/registry` holds
`pull-request-reviews`, `pull-request-reviews-opencode` (which replaces two
of its files) and `slack-threads` beside the UI packs, in the same shadcn
item format: real files with `.work/` targets, and `docs` that say what to
merge and replace. Each recipe pack installs a project skill
(`.work/skills/<name>/SKILL.md`) that explains its files to the agents
working in that project afterwards, so the guidance lives where the
automation does. Packs are not host skills.

**One capability serves them on every host.** `registry.read` (renamed from
`components.read`) lists the host's packs or fetches one by name; it only
reads. `defineRegistryCapability({ catalog })` in core builds it from a
catalog the host supplies: the desktop and the Work server both pass the
`@catamorphic/registry` build, and an embedder can pass its own packs. The
`work-projects` skill says packs exist and how to fetch one, and skills name
the capability directly instead of asking agents to discover it first.

**Tests check what agents install.** A pack's tests sit beside it and read
its files through its manifest; the server-sdk test typechecks the packs'
workflows in a project layout, and the Work server's end-to-end tests deploy
the built catalog's files.

The registry build pins framework dependencies and renders framework version
examples from its package version, shared with every library in the release.
Source manifests declare framework dependencies without independent pins;
installed files and usage notes use `{{CATAMORPHIC_VERSION}}`. The host catalog
and shadcn payload contain matching exact versions. Installed projects retain
their own pins and lockfiles until deliberately upgraded.

Considered: fetching packs from the repository on GitHub (sandboxed agents
reach only the gateway, and a pack must match the release that runs it),
and serving them as skill files (skills carry one `SKILL.md`, and packs
would again be listed for every agent).

## Consequences

An agent asked for pull request reviews or Slack threads fetches the pack,
installs it, and adapts it; other projects never see it. Members working
from their own MCP clients do not have `registry.read` yet.
