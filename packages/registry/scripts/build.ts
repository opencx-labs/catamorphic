/**
 * Compiles `src/<item>/registry-item.json` + the source files it references
 * into a flat shadcn-compatible registry payload at `dist/r/<item>.json`.
 *
 * The output mirrors what shadcn's own registry serves: each file's contents
 * are inlined so consumers can run `npx shadcn add http://host/r/<item>.json`
 * with no follow-up fetches.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { type RegistryItem, readRegistryItem } from "./item.js";

const ROOT = path.resolve(import.meta.dirname, "..");
/** Build both public registry surfaces from the versioned package at root. */
export async function buildRegistry(root = ROOT): Promise<void> {
  const SRC = path.join(root, "src");
  const DIST = path.join(root, "dist", "r");
  const { version }: { version: string } = JSON.parse(
    await fs.readFile(path.join(root, "package.json"), "utf8"),
  );
  await fs.rm(DIST, { recursive: true, force: true });
  await fs.mkdir(DIST, { recursive: true });

  const entries = await fs.readdir(SRC, { withFileTypes: true });
  const itemDirs: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      await fs.access(path.join(SRC, entry.name, "registry-item.json"));
      itemDirs.push(entry.name);
    } catch {
      // Deleted registry items may leave an empty directory in a local checkout.
    }
  }

  const index: { name: string; type: string; description?: string }[] = [];
  const catalog: RegistryItem[] = [];

  for (const name of itemDirs) {
    const itemDir = path.join(SRC, name);
    const inlined = readRegistryItem({ directory: itemDir, version });
    catalog.push(inlined);
    const outPath = path.join(DIST, `${name}.json`);
    await fs.writeFile(outPath, `${JSON.stringify(inlined, null, 2)}\n`);
    index.push({
      name: inlined.name,
      type: inlined.type,
      description: inlined.description,
    });
    console.log(`registry: built ${name} -> ${path.relative(root, outPath)}`);
  }

  const indexPath = path.join(DIST, "index.json");
  await fs.writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`);
  console.log(`registry: built index (${index.length} items)`);
  await fs.writeFile(
    path.join(root, "dist", "catalog.json"),
    `${JSON.stringify(catalog, null, 2)}\n`,
  );
}

if (import.meta.main) await buildRegistry();
