# 0314: Palette edits share one history

- **Status:** Accepted
- **Date:** 2026-11-13

## Context

Mode chips live outside the palette editor, and Ask agent uses the shared
attachment composer in place of the search textarea. Chromium cannot order
those mode changes with text edits across the two editors. Comparing draft
contents to infer native history position fails when different edits produce
the same text. The person requested undoable mode entry and Backspace exit,
and approved simplifying and unifying the implementation during alpha.

## Decision

Each palette instance owns one transient edit history for its mode, ChatDraft
and logical selection. Mode changes, text edits and attachment changes enter
that history in order. New edits discard redo. Adjacent typing groups by edit
kind, time and selection continuity; composition is one transaction.

Chromium still performs text editing and IME. Palette Undo and Redo traverse
the single history through keyboard and editing-command events. Restoring a
snapshot uses the existing composer draft contract. Other editors retain
their existing undo behavior. Retained New Tabs retain their own histories.

## Consequences

Undo order no longer depends on matching text or on a remounted editor's native
stack. Selection offsets count each attachment marker once. Palette-specific
history grouping and restoration require native editing regressions. No history
is persisted to disk or introduced into framework APIs.
