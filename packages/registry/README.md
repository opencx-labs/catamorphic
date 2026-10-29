# @catamorphic/registry

Installable source a project then owns: React components for host interfaces and
generated apps, and project recipes (ADR 0262). Items use the standard
[shadcn registry format](https://ui.shadcn.com/docs/registry/registry-item-json).
A pack is an ordinary multi-file item with source, dependencies and usage notes.
Once installed, the code belongs to the project and can be adapted.

| Pack | What it installs |
| --- | --- |
| `code-review` | Review shell, navigation, findings and diffs for apps |
| `pull-request-reviews` | A review chat per pull request on a review pool, and the workflow that posts its review, check run and summary to GitHub (`.work/` files and a project skill) |
| `pull-request-reviews-opencode` | The same reviewer as OpenCode on an open-weight model, replacing two of `pull-request-reviews`'s files |
| `slack-threads` | A project chat per Slack thread that answers mentions, with reading and citing guidance (`.work/` files and a project skill) |
| The rest | Components the host interfaces are built from: chat, runs, file explorer, editors |

A recipe pack's files target `.work/` paths. Its `docs` say what to merge (an
Environment into `.work/project.json`, say) and what to replace, and it installs a
project skill that explains the files to the agents working in that project
afterwards. Packs are not default skills: an agent fetches one when someone asks
for what it does.

## Discover and install

Agents reuse what the project already has first and follow registry locations or
instructions supplied by the project or user. Otherwise they invoke the
`registry.read` capability, which the desktop and the Work server both offer (any
host registers it with `defineRegistryCapability` from `@catamorphic/core` and its
own catalog): input `{}` lists the packs, and `{ name: "pull-request-reviews" }`
returns one installable manifest with its source and docs. It only reads: the agent
places the files, installs dependencies and applies the documented config.

For shadcn projects, install the built manifest:

```bash
bunx shadcn@latest add /absolute/path/to/packages/registry/dist/r/code-review.json
# Or from a local installation of this package:
bunx shadcn@latest add ./node_modules/@catamorphic/registry/dist/r/code-review.json
```

The package publishes to npm with the same release version as the framework.
Use the registry version matching the host; its built manifests pin all
`@catamorphic/*` dependencies to that exact release. An installed project keeps
those pins and its lockfile until it deliberately upgrades. Hosts can serve
`dist/r/` through their own static-asset pipeline. No registry server is part of
the framework. `dist/r/index.json` lists
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

## Chat timeline

`chat-timeline` (with `chat-queue` and `edge-fade`) is the conversation every
Catamorphic chat renders: the desktop and the PWA install it as copies (ADR
0218). It is five
files that install together: `chat-timeline.tsx`, `chat-steps.tsx` (the step
model and rows), `activity-text.tsx`, `turn-rows.ts` (how a turn folds into
rows, and the `WorkDisplay` choice) and `session-input.tsx`. Feed it from
`useAgentChat`: `timeline`, `pending`, `queue`, `requests`
(`chat.state?.requests`), `activity` and the actions you support; each control
shows only when its callback is given.

Host-specific pieces enter through props: `renderAttachment(attachment, place)`
for sent attachments (default: a pill with an icon and the name), `Hint`
(`{ label, shortcut?, children }`, default: the native title), `renderLink` and
`onLinkClick`, `sourceHref`, `resolveToolIcon`, `onFileClick`, `onReauth`,
`backgroundCommands`, `workDisplay`, `presentUserMessage(text)` (an element of
the host's own leading the person's message, and the words after it; the
desktop leads a sent skill with a chip) and `registerMessageNavigation`, which
hands the host previous/next actions for its own shortcut bindings. Navigation
has no on-screen buttons. Rows are memoized: keep render-affecting slots stable;
action callbacks may change every render.

Import `@catamorphic/ui/styles.css` from the host's Tailwind entry: it holds
`.cat-markdown` and the timeline's `cat-*` motion classes. Hosts provide the
global `:focus-visible` ring; the timeline draws no focus ring of its own,
only the outline that marks a deep-linked message.

Copies in this repository differ from these sources only in import specifiers,
except the few listed in `KNOWN_DRIFT` with a reason and the copy reviewed.
After changing an item, run `bun scripts/registry-copies.ts --sync desktop` and
`--sync pwa`; `bun scripts/registry-copies.ts` (part of `bun run test:scripts`)
fails on any other difference. `bun run --cwd packages/registry test` runs the
items' unit tests, including a DOM contract test for the selectors the desktop
and PWA end-to-end suites read.

## Edge fade

`edge-fade` gives any scroller overflow hints: content fades out over the last
24px of an edge it continues past, instead of being cut there, and only while
there is more that way. Give the scroller `cat-edge-fade` (from
`@catamorphic/ui/styles.css`) and call `fadeEdges(scroller)` once it is
mounted; it returns its cleanup. The scroller lays its content out as blocks,
and its size changes only outside resize observer callbacks. The timeline
fades its conversation with it; the desktop also fades its sidebars and
palette.

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
   Declare `@catamorphic/*` npm dependencies without versions; the build pins them
   from this package's `version`. In installed files and `docs`, use
   `{{CATAMORPHIC_VERSION}}` for a framework version in a command or manifest.
   Both the shadcn payload and host catalog substitute the exact release at
   build time. Third-party dependency ranges remain explicit and independent.
5. Run `bun run --cwd packages/registry build`, install the generated manifest in
   a clean consumer, and verify rendering and interactions in the host.

The existing builder emits installable items and the host catalog together. Adding
a pack requires no new tool or runtime API. Host skill hooks can direct agents to
other packs or registries without changing framework mechanics.

`ResourcePreviewContent` renders host-supplied `ResourcePreview` data from
`@catamorphic/react`: image, text, Markdown, audio, video, resource summaries,
or an explicit unavailable state,
with name, type, size and location. Load bounded content only when a preview opens;
the component owns no filesystem or network access. Hosts can compose it into
hover/focus cards through `ChatTimeline.renderLink` (sanitized href, children and
onOpen callback), while retaining the normal inline anchor fallback. Use plain
text for active documents such as HTML, and thumbnails for document formats.
Set text content `format: "markdown"` for Markdown files/attachments. The renderer
uses GFM and the host's `cat-markdown` reading styles; it never executes raw HTML,
follows embedded links or fetches embedded images. Keep truncation indicators
visible and preserve the shared header and location treatment across resources.
