# Dependency security patches

## Zod 3.25.76 collection bounds

`zod@3.25.76.patch` backports the collection size gate from Zod's
[upstream v4 fix](https://github.com/colinhacks/zod/commit/a0ebf97)
for [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)
to the v3 parser. Upstream's published fix only changes v4; replacing the
package version with v4 still leaves its bundled `zod/v3` parser unchanged.
The patch is maintained locally under Zod's MIT license.

The affected version comes from `@anthropic-ai/sandbox-runtime`. Bun applies
the version-specific `patchedDependencies` entry during installation. The
patch covers `v3/types.js` (ESM), `v3/types.cjs` (CommonJS), and the shipped
`src/v3/types.ts` source entry. Package versions and public exports stay intact.

Oversized arrays constrained with `.max()` or `.length()`, and sets constrained
with `.max()` or `.size()`, retain their existing size issue metadata and abort
before enumerating values, allocating child results, or running refinements.
Valid inputs, undersized inputs, and unconstrained schemas retain their existing
behavior. This does not introduce a global size limit for unconstrained schemas.

`apps/desktop/src/main/zod-collection-bounds.test.ts` resolves the actual v3
dependency through sandbox-runtime and exercises both module formats, including
sync/async parsing, error metadata, and normal transformations. A registry audit
will still identify the original version because audits do not inspect patches.
Remove this patch once a published v3 release provides the equivalent fix, or
once no dependency uses the v3 parser.

## npm 12.2.2 bundled glob and minimatch

`npm@12.2.2.patch` fixes npm's physically bundled glob 13.0.6 and minimatch
10.2.5. Dependency overrides alone do not replace these shipped files.
The backports follow the upstream fixes without changing package APIs:

- [glob 4682e8c](https://github.com/isaacs/node-glob/commit/4682e8c9babee1b385202ede36389634e12076d7)
  returns immediately from four aborted walk callbacks and preserves resume
  callbacks, fixing [GHSA-3g3m-2fjr-6pw4](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4).
- [minimatch 77a0f5c](https://github.com/isaacs/minimatch/commit/77a0f5c4b80bdc641c3c930a1d9edf5ad2db57f8)
  caps globstar/parent expansion at `braceExpandMax` and skips quadratic
  deduplication above 1000 patterns, fixing
  [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249).

Both shipped CommonJS and ESM builds are patched. Glob's normal minified
entrypoints contain their own older minimatch copies. They are replaced by
forwarders to glob's existing public raw implementation, which uses the patched
bundled minimatch. This removes duplicated vulnerable code rather than keeping
an embedded parser beside the patched dependency. npm's existing dependencies,
package versions, and export paths remain unchanged. The upstream Blue Oak
licenses shipped with glob and minimatch remain in place.

`scripts/npm-bundled-security.test.ts` resolves modules from npm itself, exercises
the public and raw entrypoints in both module formats, verifies traversal stops
after cancellation, and runs credential-free offline `npm pack` and `npm install`
against a temporary local package. Remove this patch once npm ships equivalent
fixes in both its dependency directories and its embedded glob bundles.
