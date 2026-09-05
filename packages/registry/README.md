# @catamorphic/registry

Shadcn-style registry of "copy into your repo" components built on top of
`@catamorphic/react` + `@catamorphic/ui`. Each item is a small chunk of UI
chrome (JSX, tailwind classes, lucide icons) that delegates all data and
state to the headless hooks shipped from `@catamorphic/react`.

Catamorphic is embed-only, so this package does **not** ship an HTTP server. Hosts install items by pointing the shadcn CLI at the built JSON manifests directly:

```bash
# Direct file path (simplest for local dev)
npx shadcn add /abs/path/to/catamorphic/packages/registry/dist/r/catamorphic-provider.json

# Once @catamorphic/registry is installed in the host (file: link or npm):
npx shadcn add ./node_modules/@catamorphic/registry/dist/r/catamorphic-provider.json
```

The `runs-panel` item is the single Runs surface for every Workflow. It uses Run
capabilities to expose cancellation, processing pause/resume, waiting-for-input
submission, selectable Batch processing scopes, and item inspection/history,
including prior failed or canceled attempts. Do not add separate panels for
Workflow authoring or execution capabilities.

Items currently shipped: `catamorphic-provider`, `project-editor`,
`file-explorer`, `git-panel`, `diff-drawer`, `runs-panel`,
`plugins-settings`, `monaco-editor`, `agent-chat`, `chat-timeline`,
`sessions-list`, `todo-progress`, and `tool-permission-card`.

The `agent-chat` item is a complete bottom-docked coding-agent conversation.
It needs only a `projectId` inside `CatamorphicAppProvider`; optimistic queued
messages, live Thinking/editing/command activity, changed-file chips, and
conversation expansion are included.

For production, hosts typically serve `packages/registry/dist/r/` from their own static-asset pipeline and point the shadcn CLI at that URL; none of this runs in end-user production traffic — registry items are build-time scaffolding that lands as React code inside the host repo.

## Layout

```
packages/registry/
  src/<item>/
    registry-item.json   ← shadcn manifest (deps, target path, type)
    <item>.tsx           ← the component the manifest references
  scripts/build.ts       ← inlines source files into dist/r/<item>.json
  dist/r/<item>.json     ← installable manifest consumed by `shadcn add`
```

## Adding an item

1. Create `src/<name>/` with `registry-item.json` + `<name>.tsx`.
2. Reference any `@catamorphic/*` peer deps in `dependencies` so hosts can
   install them with `bun add` after `shadcn add`.
3. Run `bun run build` (or rely on `turbo build`'s wiring).
4. Verify the output at `dist/r/<name>.json` and install it in a host app to
   smoke-test the component.

## Conventions

- **No state**: all data + mutations come from `@catamorphic/react` hooks.
  Items are pure JSX wrappers around those hooks.
- **No CSS modules / no theme system (yet)**: tailwind classes only,
  matching the host app's look & feel. A theming pass is phase 3.
- **Imports**: only `@catamorphic/react`, `@catamorphic/ui`, and
  `lucide-react`. Anything else gets declared in `dependencies` so the
  shadcn CLI can install it for the host.
