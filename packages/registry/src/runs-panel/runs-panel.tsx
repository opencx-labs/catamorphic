"use client";

import { useTriggerWorkflowRun, useWorkflowRuns } from "@catamorphic/react";
import type { Run } from "@catamorphic/react/types";
import { useState } from "react";

export interface RunsPanelProps {
  projectId: string;
  workflowName: string;
  /** Defaults to 25. */
  limit?: number;
  /** Called when the user clicks a run row. */
  onSelectRun?: (run: Run) => void;
}

const STATUS_TINTS: Record<Run["status"], string> = {
  pending: "text-neutral-400",
  running: "text-blue-400",
  completed: "text-emerald-400",
  failed: "text-red-400",
  cancelled: "text-neutral-500",
};

/**
 * Lists recent workflow runs and exposes a Trigger button. Triggering uses
 * `useTriggerWorkflowRun`, which invalidates the runs query on success so
 * the list updates without manual refresh.
 */
export function RunsPanel({
  projectId,
  workflowName,
  limit = 25,
  onSelectRun,
}: RunsPanelProps) {
  const runsQuery = useWorkflowRuns(projectId, workflowName, { limit });
  const trigger = useTriggerWorkflowRun(projectId, workflowName);
  const [error, setError] = useState<string | null>(null);

  const handleTrigger = async () => {
    setError(null);
    try {
      await trigger.mutateAsync();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-950">
      <header className="flex items-center justify-between border-b border-neutral-800 px-3 py-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-neutral-500">
          Runs
        </h3>
        <button
          type="button"
          onClick={handleTrigger}
          disabled={trigger.isPending}
          className="h-7 cursor-pointer rounded bg-blue-600 px-3 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50"
        >
          {trigger.isPending ? "Triggering…" : "Trigger run"}
        </button>
      </header>

      {error ? <p className="px-3 py-2 text-xs text-red-400">{error}</p> : null}

      {runsQuery.isLoading ? (
        <p className="px-3 py-3 text-xs text-neutral-500">Loading runs…</p>
      ) : null}

      {runsQuery.data && runsQuery.data.items.length === 0 ? (
        <p className="px-3 py-3 text-xs text-neutral-500">No runs yet.</p>
      ) : null}

      {runsQuery.data && runsQuery.data.items.length > 0 ? (
        <ul>
          {runsQuery.data.items.map((run) => (
            <li
              key={run.id}
              className="border-t border-neutral-900 first:border-t-0"
            >
              <button
                type="button"
                onClick={() => onSelectRun?.(run)}
                className="grid w-full grid-cols-[1fr,auto] items-center gap-3 px-3 py-2 text-left hover:bg-neutral-900"
              >
                <div>
                  <p className="text-xs font-mono text-neutral-300 truncate">
                    {run.id}
                  </p>
                  <p className="text-[11px] text-neutral-500">
                    {run.commitSha?.slice(0, 7) ?? "—"} ·{" "}
                    {new Date(run.createdAt).toLocaleString()}
                  </p>
                </div>
                <span
                  className={`text-[11px] uppercase tracking-wider ${STATUS_TINTS[run.status]}`}
                >
                  {run.status}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
