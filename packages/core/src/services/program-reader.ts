import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  fetchRemote,
  NativeProjectRepo,
  type ProjectManager,
  type ProjectRepo,
} from "@catamorphic/git";
import { publishedRef } from "@catamorphic/workflow/project-layout";

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
 * The commit "the program as shared" stands at now, without reading it:
 * the origin's `main` when the project has a remote, the local published
 * ref (else `HEAD`) for a project folder, and null for a working tree with
 * neither. Caches of what the program says are keyed by it (ADR 0193), so
 * every replica sees a deploy as soon as it lands and nothing needs
 * invalidating.
 */
export async function programRevision(
  projectManager: ProjectManager,
  tenantId: string,
  projectId: string,
): Promise<string | null> {
  if (await projectManager.localPath({ tenantId, projectId })) {
    const repo = await projectManager.open(tenantId, projectId);
    try {
      return await repo
        .resolveRef(publishedRef())
        .catch(() => repo.resolveRef("HEAD").catch(() => null));
    } finally {
      await repo.dispose();
    }
  }
  const remote = projectManager.remoteBackend;
  if (!remote) return null;
  return remote.withOrigin(tenantId, projectId, (origin) =>
    origin.resolveRef("refs/heads/main"),
  );
}

/**
 * Read the program as shared. `fn` receives the commit it reads at (null
 * for a working tree), which is what callers key their caches by.
 */
export async function withProgram<T>(
  projectManager: ProjectManager,
  tenantId: string,
  projectId: string,
  fn: (repo: ProjectRepo, ref: string | null) => Promise<T>,
  options?: { workingTree?: boolean; publishedOnly?: boolean },
): Promise<T> {
  if (await projectManager.localPath({ tenantId, projectId })) {
    const repo = await projectManager.open(tenantId, projectId);
    try {
      if (options?.workingTree) return await fn(repo, null);
      const ref = await repo
        .resolveRef(publishedRef())
        .catch(() =>
          options?.publishedOnly
            ? null
            : repo.resolveRef("HEAD").catch(() => null),
        );
      return await fn(repo, ref);
    } finally {
      await repo.dispose();
    }
  }
  const remote = projectManager.remoteBackend;
  const repo = remote
    ? await projectManager.openDev(tenantId, projectId, PROGRAM_READER)
    : await projectManager.open(tenantId, projectId);
  try {
    if (!remote) return await fn(repo, null);
    // The origin's `main` as it is now, on every read: nothing transfers
    // when this copy already has it, and no replica serves a stale tree.
    await fetchRemote({
      dev: repo,
      remote,
      tenantId,
      projectId,
      remoteBranch: "main",
    });
    const sha = await repo.resolveRef(publishedRef()).catch(() => null);
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
 * ids at a ref, a size/mtime/ctime marker of the local working file otherwise. Digests let
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
  const entries: Array<{ path: string; digest: string }> = [];
  for (const file of files) {
    if (!(repo instanceof NativeProjectRepo)) {
      const bytes = await repo.readFileBytes(file);
      if (bytes)
        entries.push({
          path: file,
          digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
        });
      continue;
    }
    const stat = await fs
      .lstat(path.join(repo.repoPath, file))
      .catch(() => null);
    if (stat)
      entries.push({
        path: file,
        digest: `stat:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`,
      });
  }
  return entries;
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
  const result: Record<string, string> = {};
  for (const file of files) {
    const bytes = await repo.readFileBytes(file);
    if (!bytes || bytes.byteLength > 2 * 1024 * 1024 || bytes.includes(0))
      continue;
    try {
      result[file] = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      /* Binary document. */
    }
  }
  return result;
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
