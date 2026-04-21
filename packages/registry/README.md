# @catamorphic/registry

Shadcn-style registry of "copy into your repo" components built on top of
`@catamorphic/react` + `@catamorphic/ui`. Each item is a small chunk of UI
chrome (JSX, tailwind classes, lucide icons) that delegates all data and
state to the headless hooks shipped from `@catamorphic/react`.

Hosts add an item with the standard shadcn CLI:

```bash
npx shadcn add http://localhost:8501/r/catamorphic-provider.json
```

## Layout

```
packages/registry/
  src/<item>/
    registry-item.json   ← shadcn manifest (deps, target path, type)
    <item>.tsx           ← the component the manifest references
  scripts/build.ts       ← inlines source files into dist/r/<item>.json
  dist/r/<item>.json     ← what the playground serves over HTTP
```

The playground's `app/r/[name]/route.ts` reads `dist/r/<name>.json` at
request time and returns the payload with permissive CORS.

## Adding an item

1. Create `src/<name>/` with `registry-item.json` + `<name>.tsx`.
2. Reference any `@catamorphic/*` peer deps in `dependencies` so hosts can
   install them with `bun add` after `shadcn add`.
3. Run `bun run build` (or rely on `turbo build`'s wiring).
4. Hit `http://localhost:8501/r/<name>.json` to verify the payload.

## Conventions

- **No state**: all data + mutations come from `@catamorphic/react` hooks.
  Items are pure JSX wrappers around those hooks.
- **No CSS modules / no theme system (yet)**: tailwind classes only,
  matching the OpenCX look & feel. A theming pass is phase 3.
- **Imports**: only `@catamorphic/react`, `@catamorphic/ui`, and
  `lucide-react`. Anything else gets declared in `dependencies` so the
  shadcn CLI can install it for the host.
