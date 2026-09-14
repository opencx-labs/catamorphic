import { useRun } from "@catamorphic/react";
import { RunDetail } from "@catamorphic/ui";
import { ProjectAuthorityProvider } from "../components/project-authority-provider.js";

export function RunScreen({
  projectId,
  runId,
}: {
  projectId: string;
  runId: string;
}) {
  const local = useRun({ runId });
  if (local.data) return <RunDetails runId={runId} />;
  if (!local.error)
    return (
      <p role="status" className="p-4 text-sm text-fg-muted">
        Loading run…
      </p>
    );
  return (
    <ProjectAuthorityProvider projectId={projectId}>
      <RunDetails runId={runId} />
    </ProjectAuthorityProvider>
  );
}
function RunDetails({ runId }: { runId: string }) {
  const run = useRun({ runId });
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
  return (
    <section
      className="min-h-0 flex-1 overflow-auto p-4"
      aria-label={`Run of ${run.data.workflowName}`}
    >
      <h1 className="mb-3 text-sm font-semibold">{run.data.workflowName}</h1>
      <RunDetail runId={runId} />
    </section>
  );
}
