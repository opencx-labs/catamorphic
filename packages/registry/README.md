# @catamorphic/registry

Installable React source for host interfaces and generated apps. Items use the
standard [shadcn registry format](https://ui.shadcn.com/docs/registry/registry-item-json).
A component pack is an ordinary multi-file item with source, dependencies and usage
notes. Once installed, the code belongs to the project and can be adapted.

## Discover and install

Agents should reuse suitable project components first and follow registry locations
or instructions supplied by the project or user. In the desktop, call `discover_capabilities` with query `components`, then
`invoke_capability` with name `components.read`. Input `{}` lists shipped items;
input `{ name: "code-review" }` returns
the same installable manifest, including source and guidance. This is read-only:
the agent must place files, install dependencies and apply any documented config.

For shadcn projects, install the built manifest:

```bash
bunx shadcn@latest add /absolute/path/to/packages/registry/dist/r/code-review.json
# Or from a local installation of this package:
bunx shadcn@latest add ./node_modules/@catamorphic/registry/dist/r/code-review.json
```

The package is currently workspace-local; do not assume a published npm package or
public registry URL. Hosts can serve `dist/r/` through their own static-asset
pipeline. No registry server is part of the framework. `dist/r/index.json` lists
items, and `dist/catalog.json` contains those same items with source for host tools.

In projects without shadcn configuration, agents can fetch a manifest through the
host tool or a supplied URL and copy its `files[].content` into the corresponding
paths. Honor explicit `target` paths, preserve relative imports, install declared
npm and registry dependencies, and read `docs`. Inspect existing files before
writing; merge intentional changes instead of overwriting customizations.

For temporary apps, put the selected source, dependency manifests and required
configuration in the artifact's explicit files. Do not install them into the user's
project. Installation, building, saving into the project and publishing remain
separate actions.

## Code review pack

`code-review` includes editable `ReviewShell`, `ReviewNavigation`, `ReviewFinding`,
and `DiffView`, plus host-token styles and an offline highlighter. It has no
Catamorphic provider or Tailwind requirement. Import from the installed
`components/catamorphic/code-review.js` barrel, adjusting the relative path.

`ReviewShell` accepts controlled `value`/`onChange` and React content slots:
`overview`, `guide`, `changes`, and `discussion`. `ReviewView` values are `overview`,
`guide`, `diff`, and `discussion`. `DiffView` accepts `path` with `patch` or
`before`/`after`, controlled `layout`/`wrap`, and their change callbacks. Findings
use immutable file/revision/side/line locations and an `onOpenSource` callback.
External review actions remain the host's responsibility.

The default diff theme maps syntax, change markers, gutters and backgrounds to the
host's existing CSS tokens. Its shadow DOM inherits the host's `color-scheme`, so
custom palettes and live theme switches need no observer or app-side setup. Type
and spacing use `--cat-font-size` and `--cat-row-h`. An explicit `options.theme`
(with `options.themeType` when needed) still selects an alternate code palette.
Outside a Catamorphic guest, supply the same theme tokens and `color-scheme` on the
containing element. Installed copies only gain these defaults when their source
is deliberately updated.

The pack targets React 19. Its `docs` field explains an optional exact `shiki`
bundler alias for small standalone review apps. Keep a host's existing full Shiki
bundle when other components need additional languages or themes. The desktop does
this for Monaco. Preserve existing app configuration when adding an alias.
JavaScript, TypeScript, JSX, TSX, JSON, CSS, HTML, Python, SQL, YAML and Bash are
bundled; other languages retain diff and search behavior as plain text. The desktop
installs the same files under its `components/catamorphic` directory.

## Other items

The catalog also includes provider/project setup, file and git views, runs,
plugins, Monaco, agent chat and timeline, sessions, todos, questions, permissions,
and resource previews. Host-facing items delegate persistent data and mutations
to `@catamorphic/react`; guest app packs may own local interaction state. Items
declare their actual dependencies and theme requirements individually.

## Add a pack

1. Create `src/<name>/registry-item.json` and its referenced source files.
2. Use `registry:block` for a multi-file pack, or `registry:component` for a primitive.
3. Include a discoverable name/description, npm and registry dependencies, and
   `docs` explaining composition, theme requirements, configuration and adaptation.
4. Keep files together with local imports. Declare explicit targets for files that
   must be installed elsewhere. Do not bake in tenant, credential or server data.
5. Run `bun run --cwd packages/registry build`, install the generated manifest in
   a clean consumer, and verify rendering and interactions in the host.

The existing builder emits installable items and the host catalog together. Adding
a pack requires no new tool or runtime API. Host skill hooks can direct agents to
other packs or registries without changing framework mechanics.
