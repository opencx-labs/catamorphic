import {
  type AgentAuthenticationRequired,
  authenticationRequiredFrom,
  graphAtom,
  useEnvironments,
  useTriggerRun,
  useWorkflow,
  useWorkflowGraph,
} from "@catamorphic/react";
import { useSetAtom } from "jotai";
import { useEffect, useState } from "react";
import { WorkflowCanvas } from "../../canvas.js";
import { RunTriggerDialog } from "../../run-trigger-dialog.js";
import { RunsPanel } from "../../runs-panel.js";
import { WorkflowEditorScope } from "../../workflow-editor-scope.js";
import { AuthenticationRequiredCard } from "./authentication-required-card.js";
import { WorkflowEnablementPanel } from "./workflow-enablement-panel.js";

/** Reads the scoped deployed graph; never asks for a builder's source files. */
export function WorkflowReview(props: {
  projectId: string;
  workflowName: string;
  onClose?: () => void;
}) {
  return (
    <WorkflowEditorScope>
      <WorkflowReviewContent {...props} />
    </WorkflowEditorScope>
  );
}

function WorkflowReviewContent({
  projectId,
  workflowName,
  onClose,
}: {
  projectId: string;
  workflowName: string;
  onClose?: () => void;
}) {
  const workflow = useWorkflow(projectId, workflowName);
  const environments = useEnvironments(projectId, { workload: "workflow" });
  const trigger = useTriggerRun({ projectId, workflowName });
  const [selected, setSelected] = useState<string>();
  const [automate, setAutomate] = useState(false);
  const [runInput, setRunInput] = useState<Record<string, unknown>>({});
  const [runOpen, setRunOpen] = useState(false);
  const [runsOpen, setRunsOpen] = useState(false);
  const [authentication, setAuthentication] =
    useState<AgentAuthenticationRequired | null>(null);
  const environment = selected ?? environments.data?.defaultEnvironment;
  const available = environments.data?.items.some(
    (item) =>
      item.name === environment &&
      item.allowed &&
      item.available &&
      item.compatible,
  );
  const setGraph = useSetAtom(graphAtom);
  useWorkflowGraph({});
  useEffect(() => {
    setGraph(workflow.data ?? null);
  }, [workflow.data, setGraph]);
  if (workflow.isPending)
    return (
      <p role="status" className="p-4 text-sm text-fg-muted">
        Loading workflow…
      </p>
    );
  if (workflow.error)
    return (
      <div role="alert" className="p-4 text-sm text-danger">
        {workflow.error.message}
        <button
          type="button"
          onClick={() => void workflow.refetch()}
          className="ml-2 underline"
        >
          Try again
        </button>
      </div>
    );
  return (
    <section
      className="relative flex h-full min-h-[400px] flex-1 flex-col"
      aria-label="Workflow review"
    >
      <header className="flex flex-wrap items-center gap-3 border-b border-border p-3">
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="text-sm text-fg-muted"
          >
            Back
          </button>
        )}
        <div className="min-w-0 flex-1">
          <h2 className="font-medium">
            {workflow.data?.displayName ?? workflowName}
          </h2>
          <p className="text-sm text-fg-muted">{workflow.data?.description}</p>
        </div>
        <label className="text-sm">
          Run on{" "}
          <select
            value={environment ?? ""}
            onChange={(event) => setSelected(event.target.value)}
            className="rounded border border-border bg-bg-inset p-1"
          >
            {!environment && <option value="">Choose environment</option>}
            {environments.data?.items
              .filter((item) => item.allowed)
              .map((item) => (
                <option
                  key={item.name}
                  value={item.name}
                  disabled={!item.available || !item.compatible}
                >
                  {item.label}
                  {item.reasons.length ? ` (${item.reasons.join("; ")})` : ""}
                </option>
              ))}
          </select>
        </label>
        <button
          type="button"
          disabled={!available}
          className="rounded border border-border px-3 py-1 text-sm disabled:opacity-50"
          onClick={() => setRunOpen(true)}
        >
          Run now
        </button>
        <button
          type="button"
          className="text-sm underline"
          onClick={() => setRunsOpen(!runsOpen)}
        >
          Recent runs
        </button>
        <button
          type="button"
          className="rounded border border-border px-3 py-1 text-sm"
          onClick={() => setAutomate(true)}
        >
          Automatic runs
        </button>
      </header>
      {environments.error && (
        <p role="alert" className="p-3 text-sm text-danger">
          {environments.error.message}
        </p>
      )}
      {authentication?.requirements.map((requirement) => (
        <AuthenticationRequiredCard
          key={requirement.alias}
          projectId={projectId}
          environment={authentication.environment}
          requirement={requirement}
          purpose="run"
          onAuthorized={() => {
            const remaining = authentication.requirements.filter(
              (item) => item.alias !== requirement.alias,
            );
            setAuthentication(
              remaining.length
                ? { ...authentication, requirements: remaining }
                : null,
            );
            if (!remaining.length) setRunOpen(true);
          }}
        />
      ))}
      {runOpen && workflow.data && (
        <RunTriggerDialog
          parameters={workflow.data.input.parameters}
          isRunning={trigger.isPending}
          initialValues={runInput}
          onClose={() => setRunOpen(false)}
          onRun={async (input) => {
            setRunInput(input);
            try {
              await trigger.mutateAsync({ input, environment });
              setRunOpen(false);
              setRunsOpen(true);
            } catch (error) {
              const required = authenticationRequiredFrom(error);
              if (required) {
                setAuthentication(required);
                setRunOpen(false);
              } else throw error;
            }
          }}
        />
      )}
      {runsOpen && (
        <div className="max-h-64 overflow-y-auto border-b border-border">
          <RunsPanel projectId={projectId} workflowName={workflowName} />
        </div>
      )}
      {!available && (
        <p className="p-3 text-sm text-fg-muted">
          No permitted execution environment is ready.
        </p>
      )}
      <div className="relative min-h-[300px] flex-1">
        <WorkflowCanvas />
      </div>
      {automate && (
        <WorkflowEnablementPanel
          projectId={projectId}
          workflowName={workflowName}
          onClose={() => setAutomate(false)}
        />
      )}
    </section>
  );
}
