---
name: desktop-interactions
description: Change Catamorphic desktop resource opening, workspace tabs and floating surfaces, scoped settings, or chat composer integration. Use for interaction state and native Electron verification; reusable chat mechanics stay in the headless React package.
---

# Desktop interactions

Read [desktop AGENTS.md](../../../apps/desktop/AGENTS.md) for the development and
verification entry points. Choose the current contract for the work:

- [Workspace interactions](../../../apps/desktop/docs/workspace-interactions.md)
- [Settings inheritance](../../../apps/desktop/docs/settings.md)
- [Chat delivery and embedding](../../../apps/desktop/docs/chat-state.md)
- [Performance measurement](../../../apps/desktop/docs/performance.md)

Use the existing transition, opening and settings primitives named there. Keep
native handles, dirty-buffer prompts and animation scheduling in desktop; headless
hooks cannot know about bubbles, tab slots or Electron. Rendering, unread cues and
persistence must agree about surface identity. Async completion belongs to its
initiating conversation or layout.

Extend the regression that crosses the relevant boundary: pure transitions for
state sequences, hook tests for deferred responses, native Electron for hit targets,
clipboard, focus and motion. A hidden DOM node does not prove a floating preview is
clickable. Inspect the visible result, including narrow layout and reduced motion
when affected. Use the real E2E configuration to select suites instead of a copied
list. Update registry source and installed consumers together for reusable changes.

Record current behavior in the linked topic guide. Add rationale to an ADR or the
design log when a decision changes. Historical design entries are evidence of prior
intent, not instructions to restore superseded behavior.

When adding a setting, update the shared settings catalog and its destination in
Settings. Keep search metadata independent of live values. Desktop project agents
receive `configuring-catamorphic-desktop` through the host skill tier and edit configuration files directly. The per-turn context supplies owning
profile, exact paths and filesystem access limits. Maintain schemas and live
validation with the UI; do not add settings-specific tools or mirrored files. Core seeds describe host-neutral mechanics and must not import desktop code.
