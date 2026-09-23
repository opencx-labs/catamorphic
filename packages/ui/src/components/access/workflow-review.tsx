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
  const triggers =
    workflow.data?.nodes.find((node) => node.type === "input")
      ?.triggerBindings ?? [];
  return (
    <section
      className="relative flex h-full min-h-[400px] flex-1 flex-col"
      aria-label="Workflow review"
    >
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
      <div className="relative min-h-[300px] flex-1">
        <WorkflowCanvas />
        {workflow.data?.description && (
          <p className="pointer-events-none absolute top-3 left-3 max-w-sm text-xs leading-relaxed text-fg-muted">
            {workflow.data.description}
          </p>
        )}
        <div className="catamorphic-editor-controls">
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="catamorphic-editor-control"
            >
              Back
            </button>
          )}
          <select
            aria-label="Run on"
            value={environment ?? ""}
            onChange={(event) => setSelected(event.target.value)}
            className="catamorphic-editor-control max-w-40"
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
          <button
            type="button"
            className="catamorphic-editor-control"
            aria-pressed={runsOpen}
            onClick={() => setRunsOpen(!runsOpen)}
          >
            Runs
          </button>
          {triggers.length > 0 && (
            <button
              type="button"
              className="catamorphic-editor-control"
              aria-pressed={automate}
              onClick={() => setAutomate(!automate)}
            >
              Automatic runs
            </button>
          )}
          <button
            type="button"
            disabled={!available}
            data-disabled-reason="No permitted execution environment is ready"
            className="catamorphic-editor-control catamorphic-editor-control-primary"
            onClick={() => setRunOpen(true)}
          >
            Run
          </button>
        </div>
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
