import fs from "node:fs/promises";
import path from "node:path";
import {
  type PluginManifest,
  type PluginPackageJson,
  parsePluginPackageJson,
} from "./manifest.js";

/**
 * A resolved plugin: the parsed `package.json` of a catamorphic plugin plus
 * the absolute directory it was loaded from. Every `PluginResolver` (local,
 * npm, git, ...) returns this shape so downstream code is source-agnostic.
 */
export interface ResolvedPlugin {
  packageName: string;
  version: string | null;
  manifest: PluginManifest;
  rootDir: string;
}

/**
 * Contract for plugin-source backends. v1 only ships a local-disk resolver;
 * npm and git resolvers implement this same interface in the future.
 */
export interface PluginResolver {
  readonly source: "local" | "npm" | "git";
  list(): Promise<ResolvedPlugin[]>;
  resolve(packageName: string): Promise<ResolvedPlugin>;
  readReadme(plugin: ResolvedPlugin): Promise<string | null>;
  readTypes(plugin: ResolvedPlugin): Promise<string | null>;
  listPluginFiles(plugin: ResolvedPlugin): Promise<Record<string, string>>;
}

export class PluginResolutionError extends Error {
  constructor(
    message: string,
    readonly packageName: string,
  ) {
    super(message);
    this.name = "PluginResolutionError";
  }
}

interface LocalPluginResolverOpts {
  /**
   * Absolute path to a directory that contains one subdirectory per plugin
   * package. For scoped packages (`@acme/example-sdk`), the subdirectory
   * name is the unscoped tail (`workflow-sdk`).
   */
  rootDir: string;
}

export class LocalPluginResolver implements PluginResolver {
  readonly source = "local" as const;
  private readonly rootDir: string;

  constructor(opts: LocalPluginResolverOpts) {
    this.rootDir = opts.rootDir;
  }

  async list(): Promise<ResolvedPlugin[]> {
    const entries = await safeReaddir(this.rootDir);
    const plugins: ResolvedPlugin[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const pluginDir = path.join(this.rootDir, entry.name);
      const plugin = await tryLoad(pluginDir);
      if (plugin) plugins.push(plugin);
    }
    return plugins.sort((a, b) => a.packageName.localeCompare(b.packageName));
  }

  async resolve(packageName: string): Promise<ResolvedPlugin> {
    const dirName = unscope(packageName);
    const pluginDir = path.join(this.rootDir, dirName);
    const plugin = await tryLoad(pluginDir);
    if (!plugin) {
      throw new PluginResolutionError(
        `Plugin '${packageName}' not found under ${this.rootDir}.`,
        packageName,
      );
    }
    if (plugin.packageName !== packageName) {
      throw new PluginResolutionError(
        `Plugin at ${pluginDir} declares name '${plugin.packageName}', expected '${packageName}'.`,
        packageName,
      );
    }
    return plugin;
  }

  async readReadme(plugin: ResolvedPlugin): Promise<string | null> {
    return readOptional(path.join(plugin.rootDir, plugin.manifest.docs.readme));
  }

  async readTypes(plugin: ResolvedPlugin): Promise<string | null> {
    return readOptional(path.join(plugin.rootDir, plugin.manifest.docs.types));
  }

  async listPluginFiles(
    plugin: ResolvedPlugin,
  ): Promise<Record<string, string>> {
    const files: Record<string, string> = {};
    await collectFiles(plugin.rootDir, plugin.rootDir, files);
    return files;
  }
}

async function tryLoad(dir: string): Promise<ResolvedPlugin | null> {
  const pkgPath = path.join(dir, "package.json");
  const raw = await readOptional(pkgPath);
  if (raw === null) return null;
  let parsed: PluginPackageJson;
  try {
    parsed = parsePluginPackageJson(JSON.parse(raw));
  } catch {
    return null;
  }
  return {
    packageName: parsed.name,
    version: parsed.version ?? null,
    manifest: parsed.catamorphic,
    rootDir: dir,
  };
}

async function readOptional(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch (err) {
    if (isNotFoundError(err)) return null;
    throw err;
  }
}

async function safeReaddir(dir: string) {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (isNotFoundError(err)) return [];
    throw err;
  }
}

function isNotFoundError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "ENOENT"
  );
}

function unscope(packageName: string): string {
  const match = packageName.match(/^@[^/]+\/(.+)$/);
  return match?.[1] ?? packageName;
}

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".turbo",
  "src",
  "__tests__",
]);

async function collectFiles(
  root: string,
  dir: string,
  out: Record<string, string>,
): Promise<void> {
  const entries = await safeReaddir(dir);
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await collectFiles(root, path.join(dir, entry.name), out);
      continue;
    }
    if (!entry.isFile()) continue;
    const full = path.join(dir, entry.name);
    const rel = path.relative(root, full).split(path.sep).join("/");
    try {
      out[rel] = await fs.readFile(full, "utf-8");
    } catch {
      // Skip binary / unreadable files. Plugins are expected to be text-only.
    }
  }
}
