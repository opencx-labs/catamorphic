import path from "node:path";
import packageJson from "../package.json";
import { readRegistryItem } from "../scripts/item.js";

/** A pack's manifest, as `registry-item.json` declares it. */
interface PackManifest {
  name: string;
  docs?: string;
  registryDependencies?: string[];
  files: { path: string; target?: string }[];
}

/**
 * A pack's files by their targets in a project (`.work/...`), read from its
 * source directory the way the build inlines them: tests check what an
 * agent installs.
 */
export function packFiles(pack: string): {
  manifest: PackManifest;
  files: Record<string, string>;
} {
  const directory = path.join(import.meta.dirname, pack);
  const manifest = readRegistryItem({
    directory,
    version: packageJson.version,
  });
  const files: Record<string, string> = {};
  for (const file of manifest.files)
    files[file.target ?? file.path] = file.content;
  return { manifest, files };
}
