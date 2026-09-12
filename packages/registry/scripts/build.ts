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

const ROOT = path.resolve(import.meta.dirname, "..");
const SRC = path.join(ROOT, "src");
const DIST = path.join(ROOT, "dist", "r");

interface RegistryFile {
  path: string;
  type: string;
  content?: string;
  target?: string;
}

interface RegistryItem {
  $schema?: string;
  name: string;
  type: string;
  description?: string;
  title?: string;
  docs?: string;
  dependencies?: string[];
  devDependencies?: string[];
  registryDependencies?: string[];
  files: RegistryFile[];
}

async function readRegistryItem(itemDir: string): Promise<RegistryItem> {
  const manifestPath = path.join(itemDir, "registry-item.json");
  const raw = await fs.readFile(manifestPath, "utf8");
  return JSON.parse(raw) as RegistryItem;
}

/**
 * Cross-item imports in source live at `../<item>/<file>.js`; installed
 * files all land flat in the same target directory, so rewrite them to
 * sibling imports (`./<file>`).
 */
function rewriteCrossItemImports(content: string): string {
  return content.replaceAll(
    /from "\.\.\/[\w-]+\/([\w-]+)\.js"/g,
    'from "./$1"',
  );
}

async function inlineFiles(
  itemDir: string,
  item: RegistryItem,
): Promise<RegistryItem> {
  const files: RegistryFile[] = [];
  for (const file of item.files) {
    const sourceName = path.basename(file.path);
    const sourcePath = path.join(itemDir, sourceName);
    const content = await fs.readFile(sourcePath, "utf8");
    files.push({ ...file, content: rewriteCrossItemImports(content) });
  }
  return { ...item, files };
}

async function build(): Promise<void> {
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
    const item = await readRegistryItem(itemDir);
    const inlined = await inlineFiles(itemDir, item);
    catalog.push(inlined);
    const outPath = path.join(DIST, `${name}.json`);
    await fs.writeFile(outPath, `${JSON.stringify(inlined, null, 2)}\n`);
    index.push({
      name: inlined.name,
      type: inlined.type,
      description: inlined.description,
    });
    console.log(`registry: built ${name} -> ${path.relative(ROOT, outPath)}`);
  }

  const indexPath = path.join(DIST, "index.json");
  await fs.writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`);
  console.log(`registry: built index (${index.length} items)`);
  await fs.writeFile(
    path.join(ROOT, "dist", "catalog.json"),
    `${JSON.stringify(catalog, null, 2)}\n`,
  );
}

await build();
