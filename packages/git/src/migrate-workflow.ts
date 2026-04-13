import type { ProjectManager } from "./project-manager.js";

export async function migrateWorkflowToProject({
  projectManager,
  tenantId,
  projectId,
  workflowName,
  workflowCode,
}: {
  projectManager: ProjectManager;
  tenantId: string;
  projectId: string;
  workflowName: string;
  workflowCode: string;
}) {
  const sanitizedName = workflowName
    .replace(/[^a-zA-Z0-9-]/g, "-")
    .toLowerCase();

  const repo = await projectManager.create(tenantId, projectId, {
    name: sanitizedName,
    initialFiles: {
      [`src/${sanitizedName}.ts`]: workflowCode,
    },
  });

  const sha = await repo.resolveRef("HEAD");
  await repo.dispose();
  return { projectId, commitSha: sha };
}
