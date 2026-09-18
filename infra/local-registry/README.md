# Local package registry (dev only)

User projects install pinned `@catamorphic/app`, `@catamorphic/parser`, and
`@catamorphic/workflow` versions. These versions are not yet published to npm.
The desktop's host preview builder can work without a project install; that does
not prove a standalone `bun install` or `vite build` succeeds.

## Start and publish

Run `bun install`, then `bun run dev:packages` from the framework checkout. The
helper uses the checkout's pinned Node, starts pinned Verdaccio on loopback port
4873 when needed, waits for readiness, builds the three packages, and publishes
using an absolute local-only configuration path. Startup diagnostics are in
`infra/local-registry/verdaccio.log`; package storage stays ignored in this
checkout. It never publishes to npm or changes user-wide configuration.

The registry is shared on this machine. Do not run publishers concurrently or
replace its storage while other worktrees use it. Published versions are
immutable: a conflict fails visibly instead of silently retaining stale code.
Bump the affected package.json and its package-version constant together before
publishing changed packages. A healthy already-populated registry can be used
without republishing.

## Install in a test project

Prefer a project-local `.catamorphic/bunfig.toml`:

```toml
[install.scopes]
"@catamorphic" = "http://localhost:4873"
```

Run `bun install` from that project's `.catamorphic/` directory, then its checks
and app build commands. Other dependencies resolve through the normal registry.
Keep this development-only file out of shared projects and deployment snapshots.
Do not overwrite an existing project configuration.

A legacy `~/.bunfig.toml` scope redirect affects every Bun project on the machine.
If an install cannot reach localhost:4873, first check
`curl --fail http://localhost:4873/-/ping`. Start the registry with the helper if
it is missing. Do not treat a working host preview as evidence the registry is
available. Remove the global redirect when moving to project-local configuration
or publicly published packages; never replace unrelated user configuration.

## Verify a clean install

When verifying local package changes, use a disposable project with a fresh Bun
cache so an older localhost registry cannot supply cached artifacts:

```sh
# From a disposable project's .catamorphic directory, before its first install:
bun install --no-cache --cache-dir ../dependency-cache
bun run --cwd apps/<app-name> build
bun run check
```

A lockfile records package integrity, not just a version. Recreating a registry
with different bytes at an old version can leave existing installs on old code
or make a clean download fail integrity verification. `--force --no-cache` does
not repair that version/lockfile conflict. Preserve existing projects and their
locks; publish changed packages under new versions and update those dependencies
explicitly. Do not reset registry storage or silently republish the same version.

The explicit publish config contains a dummy local development token, not a
production credential. Bind this permissive registry only to loopback.
