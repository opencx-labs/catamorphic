import { WorkflowPageClient } from "./workflow-page-client";

export default async function WorkflowPage({
  params,
}: {
  params: Promise<{ projectId: string; name: string }>;
}) {
  const { projectId, name } = await params;
  return <WorkflowPageClient projectId={projectId} workflowName={name} />;
}
