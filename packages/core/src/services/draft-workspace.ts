import {
  OriginDraftRepo,
  type ProjectDraft,
  type ProjectManager,
} from "@catamorphic/git";

/**
 * A turn's checkpoint in a member's draft (ADR 0044, 0191). A server draft
 * already recorded every write of the turn as a draft commit, so its tip is
 * the checkpoint; a local folder commits what the turn left uncommitted.
 * Null when there is nothing to point at.
 */
export async function checkpointDraft(input: {
  repo: ProjectDraft;
  message: string;
  author: { name: string; email: string };
}): Promise<string | null> {
  const { repo } = input;
  if (repo instanceof OriginDraftRepo)
    return repo.resolveRef("HEAD").catch(() => null);
  const status = await repo.status();
  if (!status.dirty) return null;
  return repo.commit(input.message, input.author);
}

/**
 * The folder whose `.work/app-data/store/` mirrors the member's `store/`
 * view around agent turns: a local folder itself, or for a server draft
 * (which has no folder) a disposable folder the host keeps for it. Null
 * when the host keeps no local folders.
 */
export async function draftStoreFolder(input: {
  projectManager: ProjectManager;
  repo: ProjectDraft;
  tenantId: string;
  projectId: string;
  externalUserId: string;
}): Promise<string | null> {
  if (!(input.repo instanceof OriginDraftRepo)) return input.repo.repoPath;
  return input.projectManager.draftStoreFolder({
    tenantId: input.tenantId,
    projectId: input.projectId,
    externalUserId: input.externalUserId,
  });
}
