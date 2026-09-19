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
- Build sandboxes are microVMs: `localhost` inside one is the VM, so the
  registry listens on every interface (`listen: 0.0.0.0:4873`) and runs under
  bun's runtime (`bunx --bun verdaccio`), which the macOS application firewall
  admits where a node process is silently dropped. A project whose lockfile
  pins `http://localhost:4873/...` tarballs cannot build in a sandbox; point the
  `@catamorphic` scope at the host's LAN address in that project's
  `.catamorphic/bunfig.toml` (or in `~/.bunfig.toml`) before the agent installs.
- `bun run dev:desktop` also passes the microsandbox SDK's bundled `msb` as
  `MSB_PATH`, so sandboxes never run a differently versioned `msb` from PATH
  (the two share one database and the older binary refuses a newer schema).
- When the packages ship to real npm, delete the bunfig scope entry.
