"use client";

import { useWorkflowEnablements, useWorkflows } from "@catamorphic/react";
import { useState } from "react";
import { WorkflowReview } from "./workflow-review.js";

/** A composable member workflow catalog; authoring stays in the host editor. */
export function ProjectWorkflows({ projectId }: { projectId: string }) {
  const workflows = useWorkflows(projectId);
  const enablements = useWorkflowEnablements(projectId);
  const [selected, setSelected] = useState<string | null>(null);
  if (selected)
    return (
      <WorkflowReview
        key={selected}
        projectId={projectId}
        workflowName={selected}
        onClose={() => setSelected(null)}
      />
    );
  return (
    <section
      aria-label="Project workflows"
      className="flex min-h-0 flex-col gap-3 p-4"
    >
      <div>
        <h2 className="font-medium">Workflows</h2>
        <p className="mt-1 text-sm text-fg-muted">
          Choose what runs for your account. Review access before enabling
          automatic runs.
        </p>
      </div>
      {workflows.isLoading && (
        <p role="status" className="text-sm text-fg-muted">
          Loading workflows…
        </p>
      )}
      {workflows.error && (
        <div role="alert" className="text-sm text-danger">
          <p>{workflows.error.message}</p>
          <button
            type="button"
            className="mt-2 underline"
            onClick={() => void workflows.refetch()}
          >
            Try again
          </button>
        </div>
      )}
      {workflows.isSuccess && workflows.data.length === 0 && (
        <p className="text-sm text-fg-muted">
          No deployed workflows are available to you yet.
        </p>
      )}
      <ul className="flex flex-col divide-y divide-border">
        {workflows.data?.map((workflow) => {
          const settings =
            enablements.data?.filter(
              (item) => item.workflowName === workflow.name,
            ) ?? [];
          const status = settings.some((item) => item.updateAvailable)
            ? "Update to review"
            : settings.some((item) => item.status === "suspended")
              ? "Needs attention"
              : settings.some((item) => item.status === "active")
                ? "Enabled"
                : "Not enabled";
          return (
            <li key={workflow.name}>
              <button
                type="button"
                className="flex w-full flex-col gap-1 py-3 text-left hover:text-accent"
                onClick={() => setSelected(workflow.name)}
              >
                <span className="font-medium">
                  {workflow.displayName ?? workflow.name}
                </span>
                {workflow.description && (
                  <span className="text-sm text-fg-muted">
                    {workflow.description}
                  </span>
                )}
                <span className="text-xs text-fg-muted">
                  {status} ·{" "}
                  {workflow.triggers.length
                    ? `${workflow.triggers.length} automatic trigger${workflow.triggers.length === 1 ? "" : "s"}`
                    : "Run on demand"}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
