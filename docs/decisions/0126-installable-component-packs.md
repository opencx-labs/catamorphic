# 0126: Installable component packs

- **Status:** Accepted
- **Date:** 2026-09-11
- **Supersedes:** The review-package distribution choice in 0124

## Context

Reviews are individually authored apps. Agents need reusable components they can
fetch and adapt, and hosts or users will provide more app component packs over time.

## Decision

Use the existing shadcn-compatible registry. A pack is an ordinary multi-file
registry item containing editable source, declared dependencies and usage guidance.
There is no separate pack format, app runtime, or registry service.

The code-review pack owns ReviewShell, ReviewNavigation, ReviewFinding, DiffView,
host-token styles and bounded offline highlighting. Remove @catamorphic/app/review;
the desktop installs the same source it offers to agents. App runtime payloads no
longer detect or carry review components.

Agents reuse project-owned components first. They follow project/user registry
locations and instructions, otherwise discover the host's registry. The desktop's
components.read capability lists or returns the built installable manifests through the existing discovery/invocation gateway without writing files. Other hosts may serve those manifests from their own asset pipeline.
For project apps, installed code becomes project-owned; for temporary apps, agents
include the selected files and dependency/config changes in the artifact's explicit
source snapshot. Installation does not publish an app or overwrite customizations.

The build emits a catalog from the same manifests. New packs need source,
dependencies and guidance, with no per-pack tool implementation. Hosts keep control
of registry selection and authoring doctrine through their existing skill hooks.

## Consequences

Agents can inspect and adapt source using one installation path. Pack updates are
intentional source changes, not automatic runtime upgrades. Review styling and
behavior remain consistent by default, while project customization stays possible.
