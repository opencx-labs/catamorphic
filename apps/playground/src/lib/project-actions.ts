"use server";

import { redirect } from "next/navigation";
import { api } from "./api";

const WORKFLOW_STARTER_CODE = `/**
 * @displayname __DISPLAY_NAME__
 * @description A new workflow
 */
export async function __WORKFLOW_NAME__() {
  "use workflow";

  return { success: true };
}
`;

export async function createProjectFromTemplateAction(
  templateId: string,
  templateName: string,
  defaultWorkflow: string,
) {
  const project = await api.createProject({ name: templateName, templateId });
  redirect(`/projects/${project.id}/workflows/${defaultWorkflow}`);
}

function workflowFilePathFromName(workflowName: string): string {
  const fileSafe = workflowName
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^a-zA-Z0-9-]/g, "-")
    .toLowerCase();
  return `src/${fileSafe}.ts`;
}

function starterCodeForWorkflow(
  workflowName: string,
  displayName: string,
): string {
  return WORKFLOW_STARTER_CODE.replace(
    "__WORKFLOW_NAME__",
    workflowName,
  ).replace("__DISPLAY_NAME__", displayName);
}

function buildUntitledWorkflowName(existingWorkflowNames: Set<string>): string {
  const baseName = "untitledWorkflow";
  if (!existingWorkflowNames.has(baseName)) return baseName;

  let suffix = 2;
  while (existingWorkflowNames.has(`${baseName}${suffix}`)) {
    suffix += 1;
  }
  return `${baseName}${suffix}`;
}

function displayNameFromWorkflowName(workflowName: string): string {
  const spaced = workflowName
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/^./, (char) => char.toUpperCase());
  return spaced;
}

export async function createProjectFromScratchAction(formData: FormData) {
  const rawName = formData.get("projectName");
  const projectName =
    typeof rawName === "string" && rawName.trim().length > 0
      ? rawName.trim()
      : "Untitled Project";
  const project = await api.createProject({ name: projectName });

  redirect(`/projects/${project.id}`);
}

export async function createWorkflowInProjectAction(formData: FormData) {
  const rawProjectId = formData.get("projectId");

  if (typeof rawProjectId !== "string" || rawProjectId.length === 0) {
    throw new Error("Missing project ID");
  }

  const project = await api.getProject(rawProjectId);
  const existingWorkflowNames = new Set(project.workflows.map((wf) => wf.name));
  const workflowName = buildUntitledWorkflowName(existingWorkflowNames);
  const displayName = displayNameFromWorkflowName(workflowName);
  const filePath = workflowFilePathFromName(workflowName);

  await api.writeProjectFile(rawProjectId, filePath, {
    content: starterCodeForWorkflow(workflowName, displayName),
    commitMessage: `Create workflow ${workflowName}`,
  });

  redirect(`/projects/${rawProjectId}/workflows/${workflowName}`);
}
