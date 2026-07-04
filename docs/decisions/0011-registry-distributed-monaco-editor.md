# 0011 — Code editor ships as a registry item; linking state lives in React hooks

- **Status:** Accepted
- **Date:** 2026-07-03

## Context

`@catamorphic/ui`'s Code tab only had a `renderCodeEditor` slot with a bare
`<textarea>` fallback — no syntax highlighting, TS intellisense, line
numbers, or the canvas ↔ code linking specified in `panel-editor.mdc`.
Shipping a real editor raises a packaging question for an embeddable
framework: Monaco is a multi-megabyte dependency many hosts already have
(or want to configure themselves), so baking it into `@catamorphic/ui`
would force it on every host.

## Decision

- **The editor is a registry item, not a package dependency.** The
  `monaco-editor` item in `@catamorphic/registry` ships a
  `MonacoCodeEditor` component (built on `@monaco-editor/react`) that hosts
  copy into their repo and pass to `WorkflowEditor`'s `renderCodeEditor`
  slot. Core packages (`ui`, `react`) gain **no** Monaco dependency; the
  textarea fallback remains for hosts that install nothing.
- **Bidirectional linking state is headless in `@catamorphic/react`.**
  `useCodeEditorLink` owns the canvas → code reveal requests and the code →
  canvas cursor mapping (via `findNodeAtPosition` over parser
  `sourceRange`s), including feedback-loop suppression. Any editor —
  Monaco, CodeMirror, custom — implements linking by consuming this one
  hook inside a `WorkflowEditorScope`.

Alternatives considered: a hard Monaco dependency in `@catamorphic/ui`
(rejected: bundle weight and loader/worker config imposed on all hosts);
an optional peer dependency with a subpath export (rejected: awkward
resolution errors, and the registry already exists as the copy-paste
distribution channel for opinionated chrome).

## Consequences

- The playground (and any host) gets TS highlighting, diagnostics,
  completion, line numbers, and node-click ↔ code navigation by installing
  one registry item; hosts with their own editor reuse `useCodeEditorLink`
  and get identical behavior.
- The linking behavior is unit-testable without a DOM editor, and the spec
  in `panel-editor.mdc` now points at real code.
- Cost of the shadcn model: the playground's copy of the component must be
  kept in sync with the registry source manually.
