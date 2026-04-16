"use server";

import { redirect } from "next/navigation";
import { api } from "./api";
import {
  buildUntitledWorkflowName,
  displayNameFromWorkflowName,
  starterCodeForWorkflow,
  workflowFilePathFromName,
} from "./workflow-helpers";

export async function createProjectFromTemplateAction(
  templateId: string,
  templateName: string,
  defaultWorkflow: string,
) {
  const project = await api.createProject({ name: templateName, templateId });
  redirect(`/projects/${project.id}/workflows/${defaultWorkflow}`);
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
