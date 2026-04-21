import { ProjectDetailClient } from "./project-detail-client";

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return <ProjectDetailClient projectId={projectId} />;
}
