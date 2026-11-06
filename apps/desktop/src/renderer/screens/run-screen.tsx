import { useRun, useWorkflows } from "@catamorphic/react";
import { friendlyParamName, RunDetail } from "@catamorphic/ui";
import { ProjectAuthorityProvider } from "../components/project-authority-provider.js";

export function RunScreen({
  projectId,
  runId,
}: {
  projectId: string;
  runId: string;
}) {
  const local = useRun({ runId });
  if (local.data) return <RunDetails projectId={projectId} runId={runId} />;
  if (!local.error)
    return (
      <p role="status" className="p-4 text-sm text-fg-muted">
        Loading run…
      </p>
    );
  return (
    <ProjectAuthorityProvider projectId={projectId}>
      <RunDetails projectId={projectId} runId={runId} />
    </ProjectAuthorityProvider>
  );
}
function RunDetails({
  projectId,
  runId,
}: {
  projectId: string;
  runId: string;
}) {
  const run = useRun({ runId });
  const workflows = useWorkflows(projectId);
  if (run.error)
    return (
      <p role="alert" className="p-4 text-sm text-fg-muted">
        This run is unavailable on this host or you no longer have access.
      </p>
    );
  if (!run.data)
    return (
      <p role="status" className="p-4 text-sm text-fg-muted">
        Loading run…
      </p>
    );
  const name = run.data.workflowName;
  const title =
    workflows.data?.find((workflow) => workflow.name === name)?.displayName ??
    friendlyParamName(name);
  return (
    <section
      className="min-h-0 flex-1 overflow-auto p-4"
      aria-label={`Run of ${title}`}
    >
      <h1 className="mb-3 text-sm font-semibold">{title}</h1>
      <RunDetail runId={runId} />
    </section>
  );
}
