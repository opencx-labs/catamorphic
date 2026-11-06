# vendor

Small stand-ins for packages that only reach this repository through other
tools' dependencies. Each implements exactly the part its consumer calls,
has no dependencies of its own, and replaces the real package through the
root `package.json` `overrides`, so the real package (and its advisories)
never installs.

| Package | Replaces it for | What it implements |
| --- | --- | --- |
| `micromatch` | `kysely-codegen` (`db:codegen` table filter) | `matcher` for `*`, `?` and `{a,b}`; other glob syntax is refused; no `braces` |
| `sprintf-js` | `roarr` under `global-agent` under `@electron/get` | `sprintf`, `vsprintf` for `%s %d %i %f %j %%` |

When a consumer starts calling more of a package, extend the stand-in (and its
test in `scripts/vendor.test.ts`) or drop the override.
