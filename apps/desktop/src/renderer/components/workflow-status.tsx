import type { WorkflowGraph } from "@catamorphic/react/types";
import { describeProjectPermission, friendlyParamName } from "@catamorphic/ui";
import {
  ChevronRight,
  CircleDot,
  Code2,
  FileCode,
  History,
  LoaderCircle,
  MessageSquare,
  TriangleAlert,
  Workflow,
} from "lucide-react";
import type { ReactNode } from "react";
import { ResourceInspector } from "./resource-inspector.js";
import { triggerSummary } from "./workflow-details.js";

export type WorkflowAutomation =
  | { kind: "none" }
  | { kind: "loading" }
  | { kind: "off" }
  | {
      kind: "on";
      updateAvailable: boolean;
      /** Whose automation it is: yours, or the whole project's. */
      forProject: boolean;
    }
  | { kind: "paused"; reason?: string | null };

export interface WorkflowProblem {
  message: string;
  actions: { label: string; onClick: () => void }[];
}

/** Everything the workflow tab used to put in its header, on demand. */
export function WorkflowStatus({
  graph,
  workflowName,
  filePath,
  saving,
  dirty,
  conflict,
  preview,
  problem,
  automation,
  canEdit,
  openRequest,
  onDescribeChange,
  onCode,
  onOpenInEditor,
  openInEditorDisabledReason,
  onRuns,
  onAutomation,
}: {
  graph: WorkflowGraph | null;
  workflowName: string;
  filePath: string;
  saving: boolean;
  dirty: boolean;
  conflict: boolean;
  preview: "idle" | "updating" | "ready" | "error";
  problem?: WorkflowProblem;
  automation: WorkflowAutomation;
  canEdit: boolean;
  /** Changing this opens and pins the popover (a decision is waiting). */
  openRequest?: number;
  onDescribeChange: () => void;
  onCode: () => void;
  onOpenInEditor: () => void;
  openInEditorDisabledReason?: string;
  onRuns: () => void;
  onAutomation: () => void;
}) {
  const title = graph?.displayName ?? friendlyParamName(workflowName);
  const busy = saving || preview === "updating";
  const attention = Boolean(problem) || conflict || preview === "error";
  const label = saving
    ? "Saving"
    : conflict
      ? "Changed on disk"
      : preview === "error"
        ? "Needs attention"
        : preview === "updating"
          ? "Updating"
          : dirty
            ? "Unsaved"
            : "Saved";
  const status = saving
    ? "Saving your changes"
    : conflict
      ? "Changed on disk while you were editing"
      : dirty
        ? "Unsaved changes"
        : "Saved to project";
  const previewLabel =
    preview === "error"
      ? graph
        ? "Showing the last valid version"
        : "Unavailable"
      : preview === "updating"
        ? "Updating"
        : "Up to date";
  const parameters = graph?.input.parameters ?? [];
  const triggers =
    graph?.nodes.find((node) => node.type === "input")?.triggerBindings ??
    graph?.triggers ??
    [];
  return (
    <ResourceInspector
      label="Workflow status and actions"
      pinOnClick
      openRequest={openRequest}
      content={(dismiss) => {
        const act = (action: () => void) => () => {
          dismiss();
          action();
        };
        return (
          <div data-testid="workflow-status-content">
            <header className="flex items-start gap-2.5 border-b border-border pb-3">
              <Workflow className="mt-0.5 size-4 shrink-0 text-accent" />
              <div className="min-w-0 flex-1">
                <h2 className="break-words text-[13px] font-semibold text-fg">
                  {title}
                </h2>
                {graph?.description ? (
                  <p className="mt-1 line-clamp-3 text-[11px] leading-4 text-fg-muted">
                    {graph.description}
                  </p>
                ) : null}
              </div>
            </header>
            {problem && (
              <div
                role="alert"
                className="mt-3 rounded-md border border-border bg-bg-inset p-2.5 text-[11px] leading-4"
              >
                <p className="flex gap-2 text-warning">
                  <TriangleAlert className="mt-px size-3 shrink-0" />
                  <span className="min-w-0 break-words">{problem.message}</span>
                </p>
                <div className="mt-2 flex flex-wrap gap-1 pl-4">
                  {problem.actions.map((action) => (
                    <button
                      key={action.label}
                      type="button"
                      onClick={act(action.onClick)}
                      className="cursor-pointer rounded px-1.5 py-0.5 text-fg transition-colors duration-150 hover:bg-bg-overlay"
                    >
                      {action.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <dl className="grid grid-cols-[5.5rem_1fr] gap-x-3 gap-y-2 py-3 text-[11px]">
              <Row label="Status" value={status} />
              <Row label="Preview" value={previewLabel} />
              <Row
                label="Inputs"
                value={
                  parameters.length
                    ? parameters
                        .map(
                          (param) =>
                            param.displayName ?? friendlyParamName(param.name),
                        )
                        .join(", ")
                    : "None"
                }
              />
              <Row
                label="Starts"
                value={
                  triggers.length
                    ? triggers.map(triggerSummary).join(", ")
                    : "When you or an app runs it"
                }
              />
              {automation.kind !== "none" && (
                <Row
                  label="Automatic"
                  value={
                    automation.kind === "loading"
                      ? "Checking"
                      : automation.kind === "on"
                        ? automation.updateAvailable
                          ? "On, update available"
                          : automation.forProject
                            ? "On for the project"
                            : "On for you"
                        : automation.kind === "paused"
                          ? (automation.reason ?? "Paused")
                          : "Off"
                  }
                  onClick={act(onAutomation)}
                  actionLabel="Manage automatic runs"
                />
              )}
              {graph?.connections.length ? (
                <Row
                  label="Connections"
                  value={graph.connections
                    .map((connection) => friendlyParamName(connection.alias))
                    .join(", ")}
                />
              ) : null}
              {graph?.permissions.length ? (
                <Row
                  label="Permissions"
                  value={graph.permissions
                    .map(describeProjectPermission)
                    .join("; ")}
                />
              ) : null}
              <Row
                label="Source"
                value={filePath.split("/").at(-1) ?? filePath}
                mono
                onClick={act(onCode)}
                actionLabel="View code"
              />
            </dl>
            <div className="grid grid-cols-2 gap-1 border-t border-border pt-2">
              <Action
                icon={MessageSquare}
                label="Describe a change"
                onClick={act(onDescribeChange)}
                disabledReason={
                  canEdit
                    ? undefined
                    : "Only project builders can change workflows"
                }
              />
              <Action icon={History} label="Runs" onClick={act(onRuns)} />
              <Action icon={Code2} label="View code" onClick={act(onCode)} />
              <Action
                icon={FileCode}
                label="Open in editor"
                onClick={act(onOpenInEditor)}
                disabledReason={openInEditorDisabledReason}
              />
            </div>
          </div>
        );
      }}
    >
      {(triggerProps) => (
        <button
          {...triggerProps}
          type="button"
          aria-label={`${title} status: ${label}`}
          data-testid="workflow-status-trigger"
          data-state={attention ? "attention" : busy ? "busy" : "idle"}
          className="flex h-7 max-w-56 cursor-pointer items-center gap-1.5 rounded-md px-2 text-[11px] font-medium text-fg-muted transition-colors duration-150 hover:bg-bg-overlay hover:text-fg"
        >
          <span
            className="grid size-3 shrink-0 place-items-center"
            aria-hidden="true"
          >
            <LoaderCircle
              className={`col-start-1 row-start-1 size-3 text-accent transition-opacity duration-200 ${busy ? "animate-spin opacity-100" : "opacity-0"}`}
            />
            <span
              className={`col-start-1 row-start-1 transition-[opacity,transform] duration-200 ${busy ? "scale-75 opacity-0" : "scale-100 opacity-100"}`}
            >
              {attention ? (
                <TriangleAlert className="size-3 text-warning" />
              ) : (
                <CircleDot className="size-3 text-accent" />
              )}
            </span>
          </span>
          <span className="truncate">{label}</span>
          {automation.kind === "on" && (
            <span className="shrink-0 rounded bg-bg-inset px-1.5 py-0.5 text-[9px] font-medium text-fg-faint">
              Automatic
            </span>
          )}
        </button>
      )}
    </ResourceInspector>
  );
}

function Row({
  label,
  value,
  mono,
  onClick,
  actionLabel,
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
  onClick?: () => void;
  actionLabel?: string;
}) {
  return (
    <>
      <dt className="text-fg-faint">{label}</dt>
      <dd className={`min-w-0 text-fg ${mono ? "font-mono text-[10px]" : ""}`}>
        {onClick ? (
          <button
            type="button"
            aria-label={actionLabel}
            onClick={onClick}
            className="group -mx-1.5 flex w-[calc(100%+0.75rem)] min-w-0 cursor-pointer items-center gap-2 rounded-md px-1.5 py-0.5 text-left transition-colors duration-150 ease-[cubic-bezier(0.2,0,0,1)] hover:bg-bg-raised focus-ring-inset"
          >
            <span className="min-w-0 flex-1 break-all">{value}</span>
            <ChevronRight
              aria-hidden="true"
              className="size-3 shrink-0 text-fg-faint group-hover:text-fg-muted"
            />
          </button>
        ) : (
          <span className="block break-words">{value}</span>
        )}
      </dd>
    </>
  );
}

function Action({
  icon: Icon,
  label,
  onClick,
  disabledReason,
}: {
  icon: typeof Code2;
  label: string;
  onClick: () => void;
  disabledReason?: string;
}) {
  return (
    <button
      type="button"
      onClick={() => {
        if (!disabledReason) onClick();
      }}
      aria-disabled={Boolean(disabledReason)}
      data-disabled-reason={disabledReason}
      className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-[11px] text-fg-muted transition-colors duration-150 hover:bg-bg-raised hover:text-fg aria-disabled:cursor-not-allowed aria-disabled:opacity-45"
    >
      <Icon className="size-3.5 shrink-0" />
      <span className="truncate">{label}</span>
    </button>
  );
}
