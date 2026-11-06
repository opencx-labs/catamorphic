# Sidebar sources

Every Work sidebar list uses the same source and row contract, whether supplied
by Work or a project's module. A section names `work:tabs`, another native list,
or a project-relative TypeScript module. Composer chips and palette modes use
the same rows and actions.

The [customization reference](customization-reference.md) describes the current
layout, presentation, context, access, state, workflows, background processes,
checker and confined preview. `desktop_settings.authoring` identifies the
installed SDK declarations and commands. The public
`@catamorphic/work-customization` types support `satisfies SidebarSourceModule`
and `satisfies WorkspaceConfig`; generic collections and workflow run handles
come from `@catamorphic/app`.

Source handlers receive optional current `surface` and `session` independently
from visibility predicates. Opening an addressless row reaches its action as
`action: "open"` with a separate `mode`. Ordinary successful actions return
nothing. An optional `{ open, mode?, message? }` effect requests navigation or
explicit feedback.

Row presentation resolves from the source row, then section `itemDefaults`,
then `itemOverrides[id]`. Inline `actions`, overflow `menu` and right-click
`contextMenu` are independent placements. An omitted context menu inherits
overflow; `[]` removes that placement. Section buttons use `headerActions`.

| Implementation | Location |
|---|---|
| Public source, row and layout types | `packages/work-customization/src/` |
| Layout validation and effective layers | `src/main/workspace-config.ts` |
| Confined runtime, imported-code revision and Work bridge | `src/main/sidebar-source-runtime.ts`, `sidebar-source-worker.ts`, `sidebar-source-ipc.ts` |
| Native lists and source adapters | `src/renderer/sources/` |
| Shared section and row rendering | `src/renderer/components/source-section.tsx`, `sidebar-item-row.tsx` |
| Chat chips and their shared source | `src/renderer/lib/chips.ts`, `chip-board.ts`, `chips-work.ts`, `src/renderer/sources/chips.ts` |

The [security boundary](security.md) documents confinement. The
[background runtime](background-runtime.md) describes execution after Work's UI
quits. ADRs 0234, 0239, 0277 and 0306 record the accepted boundaries.
