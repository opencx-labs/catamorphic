# Dependency audit, 2026-11-11

The audit covered the root and all workspace manifests, the installed dependency
graph, native harness downloads, generated app manifests, registry metadata,
GitHub Actions, Dockerfiles, Compose services and sandbox runtime defaults.
Versions were checked against the publishers' npm, release and container metadata.
Workspace-owned package versions remain on the existing release train.

## Main upgrades

| Area | Current pins |
| --- | --- |
| Repository Node | 26.13.1, official archives with per-platform SHA256 |
| Bun | 1.4.4, unchanged current stable release |
| Claude SDK / CLI | 0.3.322 / 2.1.322 |
| Codex SDK / CLI | 0.167.1 / 0.167.1 |
| ACP SDK | 2.6.0, using its explicit unstable ACP v1 entrypoint |
| Cloudflare Sandbox | 1.0.3, native containers and matching shim |
| OpenTelemetry | API 1.10, SDK 3.1.1, exporters/Node SDK 0.301.1 |
| React / Jotai | 19.3.1 / 3.0.2 |
| Electron / electron-vite | 45.3.0 stable / 6.0.0 |
| TypeScript / Vitest / jsdom | 7.0.2 / 5.1.0 / 31.0.0 |
| npm / Turbo | 12.2.2 / 2.11.11 |
| Docker Engine / gVisor | 29.9.3 / 20261102 |
| PostgreSQL / ClickHouse | 18.6 / 26.10.3.7 |

The other changed direct dependencies and their exact resolutions are recorded
in the workspace manifests and `bun.lock`. Docker images and Actions also carry
immutable digests or release commit hashes. Native harness executable integrity
pins and their replay fixtures were updated together. Fresh apps and copied
registry components receive the upgraded dependencies too.

## Security remediation

The original registry audit reported 56 advisory entries across 11 packages.
Compatible, version-scoped overrides select fixed releases of the affected HTTP,
URI, query parser, cryptography and matching packages without replacing older
callers' callback APIs with incompatible majors.

Two dependency trees require actual source patches:

- `zod@3.25.76`, pulled in by sandbox-runtime, still has the old collection parser.
  The local patch rejects oversized constrained arrays and sets before parsing or
  enumerating children. Tests resolve that dependency's real ESM and CommonJS
  entrypoints. The suite reproduced ten failures before the patch and passes all
  twenty cases afterward. Registry audit tools still flag its unchanged version;
  this is a locally patched finding, not a claim that the version is unaffected.
- npm 12.2.2 physically bundles older glob and minimatch code. Lockfile overrides
  do not replace those files. The npm patch backports upstream cancellation and
  amplification fixes to both module formats, and replaces minified entrypoints
  containing stale inlined copies with forwarding modules to the patched raw
  implementation. Regression tests exercise npm's actual resolved files, normal
  matching, cancellation, and an offline local pack/install.

[Patch provenance and removal conditions](../patches/README.md) identify the
upstream fixes. Patch files are inputs to the desktop Docker dependency layer,
so a clean image applies the same remediations. Release tooling uses the verified
repository Node and patched local npm instead of an independently installed CLI.

## Compatibility constraints

These are supported API constraints rather than missed upgrade candidates:

- Ghostty remains on its existing prerelease channel, moving from
  `0.4.0-next.20.g1858a59` to `0.4.0-next.21.g640db46`. The publisher's `latest`
  tag points to an older stable build without the text-input and selection APIs
  Work already uses; selecting it would regress terminal input. The
  [publisher's release metadata](https://registry.npmjs.org/ghostty-web)
  records both channels and their publication dates.
- Vite and electron-vite retain their declared Rolldown 1.2 minor ranges.
  The former global override was removed: forcing Rolldown 1.3 changes native
  preload markers without the matching Vite consumer and emits invalid renderer
  JavaScript. The publisher explicitly documents this
  [version constraint](https://github.com/rolldown/rolldown/releases/tag/v1.3.0).
- The native TypeScript 7 compiler does not supply the old JavaScript compiler
  API. Current `openapi-typescript` 7.13.0 explicitly requires TypeScript 5.x.
  Its generator keeps the supported 5.9.3 API, scoped to that dependency; the
  repository compiler remains TypeScript 7. See the
  [publisher's peer contract](https://registry.npmjs.org/openapi-typescript/7.13.0)
  and [Microsoft's compiler API guidance](https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API).
- kdbxweb and plist still consume xmldom's 0.8 API. The patched 0.8.15 line
  preserves saved vaults and plist parsing; forcing 0.9 would break both callers.
- Redocly's current parser consumes the YAML 4 schema API. Its patched 4.3.2 line
  is retained; YAML 5 removes API members that the current generator calls.
- The small repository-owned micromatch and sprintf stand-ins remain intentional
  replacements, exercised by the existing vendor contract tests.

## Operational changes

PostgreSQL 18 retains the exact existing `pgdata` volume and mounts its parent
directory. An unconverted PostgreSQL 17 cluster fails visibly instead of starting
an empty replacement. Back up the stopped volume and follow PostgreSQL's
[major-version upgrade procedure](https://www.postgresql.org/docs/18/upgrading.html)
before using an existing development volume. For a logical restore, validate
roles, databases and row counts in a separate PostgreSQL 18 migration volume,
then copy only its verified `18/docker` directory into the original volume.
Preserve the original PostgreSQL 17 files and dump for rollback. The official
[container data-layout contract](https://github.com/docker-library/docs/blob/master/postgres/README.md)
explains the parent mount and versioned directory. This change performs no data
migration.

Cloudflare 1.0 uses a fresh Worker and Durable Object namespace. Drain and release
old allocations, preserve non-rebuildable workspace files, deploy the replacement
separately and then change the host-injected URL/key. The old Worker is preserved.
See [CLOUDFLARE.md](../CLOUDFLARE.md) and [ADR 0310](decisions/0310-cloudflare-sandboxes-use-native-containers.md).
No deployment is part of this change.

The local native-container checks cover deadlines and controlled cancellation of
TERM-ignoring descendants. Wrangler's local front proxy does not deliver a real
client disconnect to the outer Worker's request signal; that network boundary
is not claimed as locally verified. Production code follows the documented
request-signal flag and explicit Durable Object signal forwarding contract.

Repository Node installation is an explicit, checksum-verified install step.
Launching tools afterward remains synchronous and offline. See
[ADR 0311](decisions/0311-verified-development-toolchains-preserve-data.md).
