import fs from "node:fs";
import path from "node:path";

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
  const manifest: PackManifest = JSON.parse(
    fs.readFileSync(path.join(directory, "registry-item.json"), "utf8"),
  );
  const files: Record<string, string> = {};
  for (const file of manifest.files)
    files[file.target ?? file.path] = fs.readFileSync(
      path.join(directory, path.basename(file.path)),
      "utf8",
    );
  return { manifest, files };
}
