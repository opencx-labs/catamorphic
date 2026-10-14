import { watch } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";

/**
 * Builds a workspace package's `dist/` JavaScript with Bun's bundler, from
 * the `bundle` field of its package.json (ADR 0232). Declarations stay with
 * `tsc`, which each package's build script runs after this.
 *
 *   "bundle": { "entry": ["src/index.ts", "src/testing/index.ts"] }
 *
 * Every entry lands at its path under `src/` (`src/testing/index.ts` →
 * `dist/testing/index.js`), and the entries of one build share chunks
 * unless `splitting` is false; a build of one entry is one file. An array of builds keeps their outputs
 * apart, as when only one entry carries a `banner`. Dependencies, peer and
 * optional dependencies (and `external`) stay imports; anything else the
 * sources import is inlined.
 *
 *   bun ../../scripts/build-package.ts          build, after emptying dist/
 *   bun ../../scripts/build-package.ts --watch  build, then again on changes
 */

export interface BundleConfig {
  entry: string[];
  splitting?: boolean;
  banner?: string;
  external?: string[];
}

interface PackageManifest {
  name?: string;
  bundle?: BundleConfig | BundleConfig[];
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

const isString = (value: unknown): value is string => typeof value === "string";

/** The builds a manifest asks for, validated. */
export function bundleConfigs(manifest: PackageManifest): BundleConfig[] {
  const { bundle } = manifest;
  if (!bundle) throw new Error(`${manifest.name ?? "package"} has no "bundle"`);
  const configs = Array.isArray(bundle) ? bundle : [bundle];
  for (const config of configs) {
    if (
      !Array.isArray(config.entry) ||
      config.entry.length === 0 ||
      !config.entry.every(isString)
    )
      throw new Error(`${manifest.name}: "bundle.entry" lists source files`);
    for (const entry of config.entry)
      if (!/^src\/.+\.tsx?$/.test(entry))
        throw new Error(`${manifest.name}: ${entry} is not a file under src/`);
  }
  return configs;
}

/** What stays an import: declared dependencies and their subpaths. */
export function externalsOf(
  manifest: PackageManifest,
  config: BundleConfig,
): string[] {
  const names = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
    ...(config.external ?? []),
  ]);
  return [...names].flatMap((name) => [name, `${name}/*`]);
}

/**
 * Chunks only where entries share code. Bun renames every declaration a
 * shared chunk exports (`class AgentSessionsService2`), so a single entry
 * stays one file, with its dynamic imports inline, and keeps its names.
 */
export function splits(config: BundleConfig): boolean {
  return config.splitting ?? config.entry.length > 1;
}

async function build(input: {
  directory: string;
  manifest: PackageManifest;
}): Promise<boolean> {
  let ok = true;
  for (const config of bundleConfigs(input.manifest)) {
    const result = await Bun.build({
      entrypoints: config.entry.map((entry) =>
        path.join(input.directory, entry),
      ),
      root: path.join(input.directory, "src"),
      outdir: path.join(input.directory, "dist"),
      target: "node",
      format: "esm",
      splitting: splits(config),
      sourcemap: "linked",
      external: externalsOf(input.manifest, config),
      ...(config.banner ? { banner: config.banner } : {}),
      throw: false,
    });
    for (const log of result.logs) console.error(log);
    ok &&= result.success;
  }
  return ok;
}

if (import.meta.main) {
  const directory = process.cwd();
  const manifest: PackageManifest = JSON.parse(
    await readFile(path.join(directory, "package.json"), "utf8"),
  );
  bundleConfigs(manifest);
  if (!process.argv.includes("--watch")) {
    await rm(path.join(directory, "dist"), { recursive: true, force: true });
    if (!(await build({ directory, manifest }))) process.exit(1);
  } else {
    // A watcher never empties dist/: the app resolving it while it runs
    // would see the package disappear, and declarations stay in place.
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running = Promise.resolve();
    const rebuild = () => {
      running = running.then(async () => {
        const started = performance.now();
        const ok = await build({ directory, manifest });
        console.log(
          `${manifest.name} ${ok ? "built" : "failed"} in ${Math.round(performance.now() - started)} ms`,
        );
      });
    };
    rebuild();
    watch(path.join(directory, "src"), { recursive: true }, () => {
      clearTimeout(timer);
      timer = setTimeout(rebuild, 50);
    });
  }
}
