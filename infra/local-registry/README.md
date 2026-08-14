# Local package registry (dev only)

User projects depend on published `@catamorphic/*` packages (`@catamorphic/app`,
`@catamorphic/parser`, `@catamorphic/workflow` — pinned by the constants in
`packages/core/src/seeds.ts` and each package's `*_PACKAGE_VERSION`). Until
those are on npm, local testing needs a local registry.

- `./publish.sh` starts verdaccio on `http://localhost:4873` (config.yaml:
  `@catamorphic/*` served locally, everything else proxied to npmjs) and
  publishes the three packages at their current versions.
- Resolution is wired through `~/.bunfig.toml`:
  `[install.scopes] "@catamorphic" = "http://localhost:4873"` — only the scope
  is redirected; all other packages hit npm as usual. (For npm/pnpm add
  `@catamorphic:registry=http://localhost:4873` to `~/.npmrc`.)
- Bump a package's version constant + package.json together, re-run
  `./publish.sh` (verdaccio refuses to overwrite a published version — bump,
  don't republish).
- When the packages ship to real npm, delete the bunfig scope entry.
