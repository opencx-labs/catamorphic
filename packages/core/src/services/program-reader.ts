import { createHash } from "node:crypto";
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

/**
 * How long a fetched origin sha is trusted before re-fetching. Reads of the
 * program come in bursts (a sync of N files, a search over a tree); one
 * fetch per burst is plenty, and roles/tools already tolerate this lag.
 */
const FETCH_TTL_MS = 5_000;
const recentFetches = new Map<string, { at: number; sha: string | null }>();

/** Drop the memoized origin fetch (a push just landed; read fresh). */
export function forgetProgramFetch(tenantId: string, projectId: string): void {
  recentFetches.delete(`${tenantId}:${projectId}`);
}

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
    const key = `${tenantId}:${projectId}`;
    const recent = recentFetches.get(key);
    if (recent && Date.now() - recent.at < FETCH_TTL_MS) {
      return await fn(repo, recent.sha);
    }
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
    recentFetches.set(key, { at: Date.now(), sha });
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

/**
 * File paths + content digests of the program under a prefix: git blob
 * ids at a ref, a sha-256 of the working-tree file otherwise. Digests let
 * a syncing client skip unchanged files without fetching them.
 */
export async function listProgramBlobs(
  repo: ProjectRepo,
  ref: string | null,
  prefix: string,
): Promise<Array<{ path: string; digest: string }>> {
  if (ref) {
    const blobs = await repo.listBlobsAtRef(ref, prefix ? { prefix } : {});
    return blobs.map((blob) => ({
      path: blob.path,
      digest: `git:${blob.oid}`,
    }));
  }
  const files = await listProgramFiles(repo, ref, prefix);
  return Promise.all(
    files.map(async (file) => ({
      path: file,
      digest: `sha256:${createHash("sha256")
        .update(await repo.readFile(file))
        .digest("hex")}`,
    })),
  );
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

/** One program file's raw bytes (binaries intact), or null when absent. */
export async function readProgramBytes(
  repo: ProjectRepo,
  ref: string | null,
  path: string,
): Promise<Uint8Array | null> {
  return ref ? repo.readBlobAtRef(ref, path) : repo.readFileBytes(path);
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
