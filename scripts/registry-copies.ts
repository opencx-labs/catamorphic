import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { rewriteCrossItemImports } from "../packages/registry/scripts/imports.js";

/**
 * Hosts install registry items (`packages/registry/src/<item>`) as copies
 * in a directory of their own, the way any shadcn consumer would. The
 * registry is the one implementation: an installed copy may differ from it
 * only in import specifiers. This finds every other difference, a
 * partly installed item, an installed copy that reaches outside its item
 * (a host module, an undeclared package), and an item whose files would
 * not install beside each other or whose sources use a package it does
 * not declare.
 *
 *   bun scripts/registry-copies.ts                      report drift
 *   bun scripts/registry-copies.ts --sync <host> [item] rewrite a host's copies from the registry
 */

const ROOT = path.resolve(import.meta.dirname, "..");
const REGISTRY_SOURCE = "packages/registry/src";

export interface RegistryHost {
  name: string;
  /** Where the host installs items, relative to the repository root. */
  dir: string;
  /** The host's suffix on relative imports. */
  extension: "" | ".js";
}

export const HOSTS: readonly RegistryHost[] = [
  {
    name: "desktop",
    dir: "apps/desktop/src/renderer/components/catamorphic",
    extension: ".js",
  },
  {
    name: "pwa",
    dir: "apps/pwa/src/components/catamorphic",
    extension: ".js",
  },
];

/** An installed copy allowed to differ, and the copy it was reviewed as. */
export interface KnownDrift {
  reason: string;
  /** {@link copyHash} of the reviewed copy: drifting further fails again. */
  copy: string;
}

/**
 * Installed copies that differ from the registry, `<host>/<file>`, each
 * with its reason. A ratchet: an entry whose copy matches again fails the
 * check until it is removed, so the list only shrinks; a copy that drifts
 * further than reviewed fails until its hash is updated.
 */
export const KNOWN_DRIFT: Readonly<Record<string, KnownDrift>> = {
  "desktop/catamorphic-provider.tsx": {
    reason:
      "Passes the host's baseUrl through to the provider; not upstream yet.",
    copy: "3b18154b1b56",
  },
  "desktop/todo-progress.tsx": {
    reason: "An opaque popover surface where the registry's is translucent.",
    copy: "c4de3f17ab3b",
  },
};

export interface RegistryItemFiles {
  name: string;
  /** File names as they install, flat in a host's directory. */
  files: string[];
  /** Files a consumer would install elsewhere (not a component, no target). */
  elsewhere: Array<{ file: string; type: string }>;
  /** The npm packages the item declares, without versions. */
  dependencies: string[];
}

export interface CopyProblem {
  /** The host whose copy it is, or `registry` for the item itself. */
  host: string;
  file: string;
  kind: "drift" | "stale-exception" | "partial" | "import" | "manifest";
  detail: string;
}

/** A short fingerprint of a copy as compared: see {@link normalize}. */
export function copyHash(source: string): string {
  return createHash("sha256")
    .update(normalize(source))
    .digest("hex")
    .slice(0, 12);
}

/** Every registry item with its files and declared packages. */
export function registryItems(root: string): RegistryItemFiles[] {
  const source = path.join(root, REGISTRY_SOURCE);
  return readdirSync(source, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        existsSync(path.join(source, entry.name, "registry-item.json")),
    )
    .map((entry) => {
      const manifest: unknown = JSON.parse(
        readFileSync(
          path.join(source, entry.name, "registry-item.json"),
          "utf8",
        ),
      );
      const files = listOf(manifest, "files");
      return {
        name: entry.name,
        files: files.map((file) => path.basename(stringField(file, "path"))),
        elsewhere: files.flatMap((file) => {
          const type = stringField(file, "type");
          return type &&
            type !== "registry:component" &&
            !stringField(file, "target")
            ? [{ file: path.basename(stringField(file, "path")), type }]
            : [];
        }),
        dependencies: listOf(manifest, "dependencies")
          .filter((name): name is string => typeof name === "string")
          .map(packageName),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * A source as compared: cross-item imports flattened the way the build
 * installs them, no `.js` on relative imports, and each import statement
 * on one line, in order. A host's shorter specifiers let the formatter
 * join an import's lines and sort it among the others differently.
 */
export function normalize(source: string): string {
  const lines = withoutJsSpecifiers(rewriteCrossItemImports(source))
    .replaceAll(
      /^(?:import|export)\b[^;]*?\bfrom\s+["'][^"']+["'];/gm,
      (statement) =>
        statement.replaceAll(/\s+/g, " ").replaceAll(/,\s*\}/g, " }"),
    )
    .split("\n");
  // A bare `import "x";` runs for its effect: its order is kept.
  const sortable = (line: string) => /^import\b(?!\s*["']).*;$/.test(line);
  const imports = lines.filter(sortable).sort((a, b) => a.localeCompare(b));
  let next = 0;
  return lines
    .map((line) => (sortable(line) ? (imports[next++] ?? "") : line))
    .join("\n");
}

/** Relative import and export specifiers without their `.js`. */
function withoutJsSpecifiers(source: string): string {
  return source.replaceAll(
    /(\bfrom\s+|\bimport\s*\(?\s*)(["'])(\.\.?\/[^"'\n]+)\.js\2/g,
    "$1$2$3$2",
  );
}

/** A registry source as a host installs it. */
export function installedSource(source: string, host: RegistryHost): string {
  const flat = rewriteCrossItemImports(source, host.extension);
  return host.extension === ".js" ? flat : withoutJsSpecifiers(flat);
}

/** The module specifiers a source imports or re-exports. */
export function importsOf(source: string): string[] {
  return [
    ...source.matchAll(/(?:\bfrom\s+|\bimport\s*\(?\s*)["']([^"']+)["']/g),
  ].flatMap((match) => (match[1] ? [match[1]] : []));
}

/** The package a specifier names: `@scope/name` or `name`, without a subpath or version. */
export function packageName(specifier: string): string {
  const parts = specifier.split("/");
  const name = specifier.startsWith("@")
    ? parts.slice(0, 2).join("/")
    : (parts[0] ?? specifier);
  const at = name.indexOf("@", 1);
  return at === -1 ? name : name.slice(0, at);
}

/** React itself is every component's peer; items do not declare it. */
const PEERS = new Set(["react", "react-dom"]);

/** Why an installed copy may not import this, or undefined when it may. */
export function disallowedImport(
  specifier: string,
  item: RegistryItemFiles,
  installedDir: string,
): string | undefined {
  if (specifier.startsWith("./")) {
    const base = path.join(installedDir, specifier.replace(/\.js$/, ""));
    const found = ["", ".ts", ".tsx", ".js", ".css"].some((extension) =>
      existsSync(`${base}${extension}`),
    );
    return found
      ? undefined
      : `imports ${specifier}, which is not installed beside it`;
  }
  if (specifier.startsWith("."))
    return `imports ${specifier}: an installed copy reaches only its own directory`;
  const name = packageName(specifier);
  if (PEERS.has(name) || item.dependencies.includes(name)) return undefined;
  return `imports ${specifier}, which the ${item.name} item does not declare`;
}

/** Everything that keeps installed copies from being the registry's. */
export function checkRegistryCopies({
  root = ROOT,
  hosts = HOSTS,
  knownDrift = KNOWN_DRIFT,
}: {
  root?: string;
  hosts?: readonly RegistryHost[];
  knownDrift?: Readonly<Record<string, KnownDrift>>;
} = {}): CopyProblem[] {
  const problems: CopyProblem[] = [];
  const items = registryItems(root);
  const exceptions = new Set(Object.keys(knownDrift));
  // The items themselves: what a consumer installs, and what they import.
  for (const item of items) {
    for (const { file, type } of item.elsewhere)
      problems.push({
        host: "registry",
        file,
        kind: "manifest",
        detail: `${item.name} lists it as ${type}: it would not install beside the item's other files`,
      });
    for (const file of item.files) {
      const sourcePath = path.join(root, REGISTRY_SOURCE, item.name, file);
      if (!existsSync(sourcePath)) continue;
      for (const specifier of importsOf(readFileSync(sourcePath, "utf8"))) {
        if (specifier.startsWith(".")) continue;
        const name = packageName(specifier);
        if (PEERS.has(name) || item.dependencies.includes(name)) continue;
        problems.push({
          host: "registry",
          file,
          kind: "import",
          detail: `imports ${specifier}, which the ${item.name} item does not declare`,
        });
      }
    }
  }
  for (const host of hosts) {
    const installedDir = path.join(root, host.dir);
    for (const item of items) {
      const present = item.files.filter((file) =>
        existsSync(path.join(installedDir, file)),
      );
      if (present.length === 0) continue;
      const missing = item.files.filter((file) => !present.includes(file));
      if (missing.length > 0)
        problems.push({
          host: host.name,
          file: present[0] ?? item.name,
          kind: "partial",
          detail: `${item.name} is partly installed: missing ${missing.join(", ")}`,
        });
      for (const file of present) {
        const key = `${host.name}/${file}`;
        const installed = readFileSync(path.join(installedDir, file), "utf8");
        const source = readFileSync(
          path.join(root, REGISTRY_SOURCE, item.name, file),
          "utf8",
        );
        const same = normalize(installed) === normalize(source);
        const known = knownDrift[key];
        if (!same && !known)
          problems.push({
            host: host.name,
            file,
            kind: "drift",
            detail: `differs from ${REGISTRY_SOURCE}/${item.name}/${file} beyond its imports`,
          });
        if (!same && known && known.copy !== copyHash(installed))
          problems.push({
            host: host.name,
            file,
            kind: "drift",
            detail: `drifted further than KNOWN_DRIFT records: review it, then set its copy to ${copyHash(installed)}`,
          });
        if (same && exceptions.has(key))
          problems.push({
            host: host.name,
            file,
            kind: "stale-exception",
            detail: "matches the registry again: remove it from KNOWN_DRIFT",
          });
        exceptions.delete(key);
        for (const specifier of importsOf(installed)) {
          const reason = disallowedImport(specifier, item, installedDir);
          if (reason)
            problems.push({
              host: host.name,
              file,
              kind: "import",
              detail: reason,
            });
        }
      }
    }
  }
  for (const key of exceptions) {
    const [host = "", file = key] = key.split("/");
    problems.push({
      host,
      file,
      kind: "stale-exception",
      detail: "no longer installed: remove it from KNOWN_DRIFT",
    });
  }
  return problems;
}

/**
 * Rewrites a host's installed copies from the registry: every installed
 * item, or the one named (installing it when it is not). Known drift is
 * left alone unless its item is named.
 */
export function syncRegistryCopies({
  root = ROOT,
  host,
  item: only,
  knownDrift = KNOWN_DRIFT,
}: {
  root?: string;
  host: RegistryHost;
  item?: string;
  knownDrift?: Readonly<Record<string, KnownDrift>>;
}): string[] {
  const installedDir = path.join(root, host.dir);
  const items = registryItems(root).filter((item) =>
    only
      ? item.name === only
      : item.files.some((file) => existsSync(path.join(installedDir, file))),
  );
  if (only && items.length === 0)
    throw new Error(`No registry item named ${only}`);
  const written: string[] = [];
  for (const item of items)
    for (const file of item.files) {
      if (!only && knownDrift[`${host.name}/${file}`]) continue;
      const source = readFileSync(
        path.join(root, REGISTRY_SOURCE, item.name, file),
        "utf8",
      );
      const target = path.join(installedDir, file);
      const next = installedSource(source, host);
      // Already the registry's, as the host formats it.
      if (
        existsSync(target) &&
        normalize(readFileSync(target, "utf8")) === normalize(next)
      )
        continue;
      mkdirSync(installedDir, { recursive: true });
      writeFileSync(target, next);
      written.push(path.relative(root, target));
    }
  return written;
}

function listOf(value: unknown, key: string): unknown[] {
  if (typeof value !== "object" || value === null) return [];
  const list: unknown = Reflect.get(value, key);
  return Array.isArray(list) ? list : [];
}

function stringField(value: unknown, key: string): string {
  if (typeof value !== "object" || value === null) return "";
  const field: unknown = Reflect.get(value, key);
  return typeof field === "string" ? field : "";
}

/** The normalized difference between a copy and its source, for people. */
function diffOf(root: string, problem: CopyProblem): string {
  const host = HOSTS.find((candidate) => candidate.name === problem.host);
  const item = registryItems(root).find((candidate) =>
    candidate.files.includes(problem.file),
  );
  if (!host || !item) return "";
  const scratch = mkdtempSync(path.join(os.tmpdir(), "registry-copies-"));
  try {
    const registry = path.join(scratch, `registry-${problem.file}`);
    const installed = path.join(scratch, `${host.name}-${problem.file}`);
    writeFileSync(
      registry,
      normalize(
        readFileSync(
          path.join(root, REGISTRY_SOURCE, item.name, problem.file),
          "utf8",
        ),
      ),
    );
    writeFileSync(
      installed,
      normalize(readFileSync(path.join(root, host.dir, problem.file), "utf8")),
    );
    return spawnSync(
      "git",
      ["diff", "--no-index", "--no-color", "--", registry, installed],
      { encoding: "utf8" },
    ).stdout;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function main(args: readonly string[]): number {
  if (args[0] === "--sync") {
    const host = HOSTS.find((candidate) => candidate.name === args[1]);
    if (!host || args.length > 3) {
      console.error(
        `Usage: bun scripts/registry-copies.ts --sync <${HOSTS.map((candidate) => candidate.name).join("|")}> [item]`,
      );
      return 1;
    }
    const written = syncRegistryCopies({ host, item: args[2] });
    if (written.length === 0) {
      console.log(`${host.name} copies are current`);
      return 0;
    }
    // The host's own specifiers can join and reorder its import lines.
    const formatted = spawnSync(
      path.join(ROOT, "node_modules/.bin/biome"),
      ["check", "--write", ...written],
      { cwd: ROOT, stdio: "inherit" },
    );
    for (const file of written) console.log(`wrote ${file}`);
    return formatted.status ?? 1;
  }
  if (args.length > 0) {
    console.error(
      "Usage: bun scripts/registry-copies.ts [--sync <host> [item]]",
    );
    return 1;
  }
  const problems = checkRegistryCopies();
  for (const problem of problems) {
    console.log(`${problem.host}/${problem.file}: ${problem.detail}`);
    if (problem.kind === "drift") console.log(diffOf(ROOT, problem));
  }
  if (problems.length === 0) console.log("Installed registry copies match.");
  return problems.length === 0 ? 0 : 1;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
