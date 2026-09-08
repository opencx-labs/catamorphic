import path from "node:path";
import type { FileReadOptions, ProjectRepo } from "@catamorphic/git";

/** Select parser inputs before opening files in general-purpose projects. */
export const WORKFLOW_READ_OPTIONS: FileReadOptions = {
  excludeNestedRepositories: true,
  filter: (file) =>
    /(^|\/)(package|tsconfig)\.json$/.test(file) ||
    (!file.startsWith("apps/") && /\.[cm]?tsx?$/.test(file)) ||
    (file.startsWith("apps/") && file.endsWith(".d.ts")),
};

/** Native Git narrows discovery before ts-morph sees source; relative imports bring their dependencies. */
export async function workflowSourceFiles(
  repo: ProjectRepo,
  ref?: string,
): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const read = async (file: string): Promise<string | null> => {
    const bytes = ref
      ? await repo.readBlobAtRef(ref, file)
      : await repo.readFileBytes(file);
    if (!bytes || bytes.byteLength > 2 * 1024 * 1024 || bytes.includes(0))
      return null;
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return null;
    }
  };
  if (!repo.findFilesContaining) {
    const sources = ref
      ? await repo.readAllFilesAtRef(ref, WORKFLOW_READ_OPTIONS)
      : await repo.readAllFiles(WORKFLOW_READ_OPTIONS);
    for (const [file, content] of Object.entries(sources)) {
      if (/\.(?:[cm]?tsx?|json)$/.test(file) && !file.startsWith("apps/"))
        files[file] = content;
    }
    return files;
  }
  const globs = ["*.ts", "*.tsx", "*.mts", "*.cts", ":!apps/**", ":!store/**"];
  const pending = [
    ...new Set(
      (
        await Promise.all([
          repo.findFilesContaining({ text: "defineWorkflow", ref, globs }),
          repo.findFilesContaining({ text: "defineSecrets", ref, globs }),
        ])
      ).flat(),
    ),
  ];
  if (pending.length === 0) return files;
  pending.push("contracts/src/index.ts");
  const visited = new Set<string>();
  let totalBytes = 0;
  while (pending.length > 0) {
    const file = pending.pop();
    if (!file || visited.has(file)) continue;
    visited.add(file);
    const content = await read(file);
    if (content === null) continue;
    totalBytes += Buffer.byteLength(content);
    if (totalBytes > 64 * 1024 * 1024)
      throw new Error("Workflow sources exceed the 64 MiB snapshot limit");
    files[file] = content;
    for (const match of content.matchAll(
      /(?:from\s*|import\s*\(|import\s*)["'](\.[^"']+)["']/g,
    )) {
      const specifier = match[1];
      if (!specifier) continue;
      const base = path.posix.normalize(
        path.posix.join(path.posix.dirname(file), specifier),
      );
      if (base.startsWith("../")) continue;
      for (const candidate of [
        base,
        base.replace(/\.js$/, ".ts"),
        `${base}.ts`,
        `${base}.tsx`,
        `${base}/index.ts`,
      ]) {
        if (!visited.has(candidate)) pending.push(candidate);
      }
    }
  }
  for (const file of ["tsconfig.json", "package.json"]) {
    const content = await read(file);
    if (content !== null) files[file] = content;
  }
  return files;
}
