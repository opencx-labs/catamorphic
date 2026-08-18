import {
  fetchRemote,
  type ProjectManager,
  type ProjectRepo,
} from "@catamorphic/git";

/**
 * Reads of "the program as shared" (ADR 0055): the project's origin `main`
 * when it has a remote, its working tree otherwise (single-machine hosts,
 * where the folder is the truth). Used wherever core reads committed
 * policy or content on behalf of someone who is not necessarily a
 * collaborator with a working copy — role files, the documents surface —
 * so viewers never get a clone of their own.
 *
 * The reader identity names one shared dev copy per project on backends
 * that keep per-user working copies; on `pathResolver` backends (the
 * desktop) it is the project folder itself.
 */
export const PROGRAM_READER = "catamorphic-reader";

export async function withProgram<T>(
  projectManager: ProjectManager,
  tenantId: string,
  projectId: string,
  fn: (repo: ProjectRepo, ref: string | null) => Promise<T>,
): Promise<T> {
  const remote = projectManager.remoteBackend;
  const repo = remote
    ? await projectManager.openDev(tenantId, projectId, PROGRAM_READER)
    : await projectManager.open(tenantId, projectId);
  try {
    if (!remote) return await fn(repo, null);
    await fetchRemote({
      dev: repo,
      remote,
      tenantId,
      projectId,
      remoteBranch: "main",
    });
    const sha = await repo
      .resolveRef("refs/remotes/origin/main")
      .catch(() => null);
    return await fn(repo, sha);
  } finally {
    await repo.dispose();
  }
}

/** File paths of the program under a prefix (`""` = whole tree). */
export async function listProgramFiles(
  repo: ProjectRepo,
  ref: string | null,
  prefix: string,
): Promise<string[]> {
  if (ref) return repo.listFilesAtRef(ref, prefix ? { prefix } : {});
  const all = await repo.listFiles();
  return all.filter((file) => file.startsWith(prefix)).sort();
}

/** Contents of the program's files under a prefix. */
export async function readProgramFiles(
  repo: ProjectRepo,
  ref: string | null,
  prefix: string,
): Promise<Record<string, string>> {
  if (ref) {
    return prefix
      ? repo.readFilesAtRef(ref, { prefix })
      : repo.readAllFilesAtRef(ref);
  }
  const files = await listProgramFiles(repo, ref, prefix);
  const entries = await Promise.all(
    files.map(async (file) => [file, await repo.readFile(file)] as const),
  );
  return Object.fromEntries(entries);
}

/** One program file, or null when absent. */
export async function readProgramFile(
  repo: ProjectRepo,
  ref: string | null,
  path: string,
): Promise<string | null> {
  if (ref) {
    const files = await repo.readFilesAtRef(ref, { prefix: path });
    return files[path] ?? null;
  }
  try {
    return await repo.readFile(path);
  } catch {
    return null;
  }
}
