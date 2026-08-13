import fs from "node:fs/promises";
import path from "node:path";
import type { AttachedPluginForAgent } from "./types.js";

/**
 * Directory name (inside the agent's working directory) where plugin docs
 * are staged. The preamble tells the agent to look here; it's kept separate
 * from the workflow author's own `node_modules/` so nothing shadows real
 * package resolution at run time.
 */
export const PLUGIN_STAGE_DIR = "_plugins";

/**
 * Write each attached plugin's staged files under
 * `<workingDirectory>/_plugins/<scoped-package-slug>/`. We use a slug (replace
 * `/` with `__`) so directory names stay flat and easy to reference from the
 * preamble.
 *
 * Local-filesystem variant — used by agents whose working directory is a path
 * on the host. Agents that operate on a remote sandbox stage the same
 * `stagedPluginFiles` map through the sandbox provider's upload API instead.
 */
export async function stagePluginDocs(
  workingDirectory: string,
  plugins?: AttachedPluginForAgent[],
): Promise<void> {
  const files = stagedPluginFiles(plugins);
  for (const [relPath, content] of Object.entries(files)) {
    const full = path.join(workingDirectory, relPath);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, "utf-8");
  }
}

/**
 * Flat map of `_plugins/<slug>/<file>` → contents for every attached plugin,
 * ready to hand to any file-writing mechanism (host fs, sandbox upload).
 */
export function stagedPluginFiles(
  plugins?: AttachedPluginForAgent[],
): Record<string, string> {
  if (!plugins || plugins.length === 0) return {};
  const entries = plugins.flatMap((plugin) =>
    Object.entries(plugin.files).map(([relPath, content]): [string, string] => [
      `${PLUGIN_STAGE_DIR}/${slugifyPackage(plugin.packageName)}/${relPath}`,
      content,
    ]),
  );
  return Object.fromEntries(entries);
}

export function buildPluginsPreamble(
  plugins?: AttachedPluginForAgent[],
): string {
  if (!plugins || plugins.length === 0) return "";
  const lines = plugins.map((plugin) => {
    const slug = slugifyPackage(plugin.packageName);
    const fileList = Object.keys(plugin.files).sort();
    const paths = fileList
      .map((f) => `${PLUGIN_STAGE_DIR}/${slug}/${f}`)
      .join(", ");
    const description = plugin.description ? ` — ${plugin.description}` : "";
    return `- ${plugin.packageName} (${plugin.displayName})${description}. Docs: ${paths}`;
  });
  return [
    "Attached packages (available for the project's code to import):",
    ...lines,
    "Read the listed doc files before using a package.",
  ].join("\n");
}

function slugifyPackage(packageName: string): string {
  return packageName.replace(/^@/, "").replace(/\//g, "__");
}
