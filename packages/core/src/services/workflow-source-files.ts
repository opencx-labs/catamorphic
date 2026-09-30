import path from "node:path";
import {
  type FileReadOptions,
  OriginDraftRepo,
  type ProjectDraft,
} from "@catamorphic/git";
import {
  isProjectPathWithin,
  isProjectSourcePath,
  PROJECT_APPS_DIR,
  PROJECT_CONTRACTS_DIR,
  PROJECT_PACKAGE_PATH,
  PROJECT_TSCONFIG_PATH,
  PROJECT_WORKFLOWS_DIR,
} from "@catamorphic/workflow/project-layout";

/** Select parser inputs before opening files in general-purpose projects. */
export const WORKFLOW_READ_OPTIONS: FileReadOptions = {
  excludeNestedRepositories: true,
  filter: (file) =>
    isProjectSourcePath(file) &&
    (/(^|\/)(package|tsconfig)\.json$/.test(file) ||
      (!isProjectPathWithin(file, PROJECT_APPS_DIR) &&
        /\.[cm]?tsx?$/.test(file)) ||
      (isProjectPathWithin(file, PROJECT_APPS_DIR) && file.endsWith(".d.ts"))),
};

/** Native Git narrows discovery before ts-morph sees source; relative imports bring their dependencies. */
export async function workflowSourceFiles(
  repo: ProjectDraft,
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
  const find =
    repo instanceof OriginDraftRepo
      ? undefined
      : repo.findFilesContaining?.bind(repo);
  if (!find) {
    const sources = ref
      ? await repo.readAllFilesAtRef(ref, WORKFLOW_READ_OPTIONS)
      : await repo.readAllFiles(WORKFLOW_READ_OPTIONS);
    for (const [file, content] of Object.entries(sources)) {
      if (
        /\.(?:[cm]?tsx?|json)$/.test(file) &&
        !isProjectPathWithin(file, PROJECT_APPS_DIR)
      )
        files[file] = content;
    }
    return files;
  }
  const globs = ["ts", "tsx", "mts", "cts"].flatMap((extension) => [
    `${PROJECT_WORKFLOWS_DIR}/*.${extension}`,
    `${PROJECT_WORKFLOWS_DIR}/**/*.${extension}`,
  ]);
  const pending = [
    ...new Set(
      (
        await Promise.all([
          find({ text: "defineWorkflow", ref, globs }),
          find({ text: "defineSecrets", ref, globs }),
        ])
      ).flat(),
    ),
  ];
  if (pending.length === 0) return files;
  pending.push(`${PROJECT_CONTRACTS_DIR}/src/index.ts`);
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
      if (!isProjectSourcePath(base)) continue;
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
  for (const file of [PROJECT_TSCONFIG_PATH, PROJECT_PACKAGE_PATH]) {
    const content = await read(file);
    if (content !== null) files[file] = content;
  }
  return files;
}
