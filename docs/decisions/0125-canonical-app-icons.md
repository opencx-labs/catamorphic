# 0125: Canonical semantic app icons

- **Status:** Accepted; permanent agent tool superseded by [0133](0133-lean-agent-tool-surface.md)
- **Date:** 2026-09-11

## Context

Agents should customize app identity as they do chat identity, while common
app types remain recognizable across projects and sessions.

## Decision

Use one extensible semantic icon vocabulary for project and temporary apps:
default, review, dashboard, report, tracker, form, and calculator. Agents select
a name through `set_app_presentation`; they do not choose arbitrary glyphs or colors.
Reviews always select review. When no type clearly fits, use default.

Store the icon on the existing apps record as presentation metadata. Titles
reuse session_artifacts.title for temporary apps and apps.title for project
apps. One presentation endpoint resolves both, and its update accepts either
field. Agents receive concise descriptive-title guidance, not strict templates. Changing
an icon does not change source, build, publication, or permissions. The app
package exports the vocabulary, descriptions, and fallback resolver. Hosts map
those semantic names to their own glyph library and theme. Desktop uses one
mapping everywhere an individual app is represented. Unset and unknown names
render the existing grid icon; there is no inference from app names or source.

Project builders may set project app icons. Temporary apps retain their existing
session ownership rules. Metadata reads use the same app visibility boundary.

## Consequences

New common types need one vocabulary entry and a host glyph mapping. Older
clients keep a safe visual fallback. Icon edits require no app rebuild and are
visible to already-open tabs and chat surfaces.
