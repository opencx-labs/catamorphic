"use server";

import { redirect } from "next/navigation";
import { api } from "./api";

export async function createProjectFromTemplateAction(
  templateId: string,
  templateName: string,
  defaultWorkflow: string,
) {
  const project = await api.createProject({ name: templateName, templateId });
  redirect(`/projects/${project.id}/workflows/${defaultWorkflow}`);
}
