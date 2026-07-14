import {
  useBatchRuns,
  useCancelBatchRun,
  usePauseBatchRun,
  useResumeBatchRun,
  useRetryFailedBatchItems,
  useTriggerBatchRun,
} from "@catamorphic/react";

export function BatchRunsPanel({
  projectId,
  workflowName,
}: {
  projectId: string;
  workflowName: string;
}) {
  const runs = useBatchRuns({ projectId, workflowName, limit: 20 });
  const trigger = useTriggerBatchRun({ projectId, workflowName });
  const pause = usePauseBatchRun({ projectId, workflowName });
  const resume = useResumeBatchRun({ projectId, workflowName });
  const cancel = useCancelBatchRun({ projectId, workflowName });
  const retry = useRetryFailedBatchItems({ projectId, workflowName });
  const error =
    runs.error ??
    trigger.error ??
    pause.error ??
    resume.error ??
    cancel.error ??
    retry.error;

  return (
    <div className="catamorphic-runs-panel">
      <div className="catamorphic-run-row-section">
        <button
          type="button"
          className="pg-btn"
          disabled={trigger.isPending}
          onClick={() => trigger.mutate(undefined)}
        >
          {trigger.isPending ? "Starting…" : "Start production batch"}
        </button>
        {error ? <p className="pg-error">{error.message}</p> : null}
      </div>
      {runs.isLoading ? (
        <span className="catamorphic-runs-loading">Loading…</span>
      ) : null}
      {runs.data?.items.map((run) => {
        const processed =
          run.completedCount + run.failedCount + run.skippedCount;
        const percentage =
          run.discoveredCount === 0
            ? 0
            : Math.round((processed / run.discoveredCount) * 100);
        return (
          <div key={run.id} className="catamorphic-run-row">
            <div className="catamorphic-run-row-header">
              <span className="catamorphic-run-row-time">
                {new Date(run.createdAt).toLocaleTimeString()}
              </span>
              <span className="catamorphic-run-status">{run.status}</span>
            </div>
            <div className="catamorphic-run-row-body">
              <div className="catamorphic-run-row-section">
                <p>
                  {processed} / {run.discoveredCount} items ({percentage}%)
                </p>
                <p>
                  {run.completedCount} completed · {run.failedCount} failed ·{" "}
                  {run.skippedCount} skipped
                </p>
                {run.sinkTotalChunks > 0 ? (
                  <p>
                    Sink {run.sinkCompletedChunks}/{run.sinkTotalChunks} chunks
                  </p>
                ) : null}
                {run.error ? <p className="pg-error">{run.error}</p> : null}
                <div>
                  {run.status === "paused" ? (
                    <button
                      type="button"
                      className="pg-btn"
                      onClick={() => resume.mutate({ batchRunId: run.id })}
                    >
                      Resume
                    </button>
                  ) : ["pending", "sourcing", "running", "sinking"].includes(
                      run.status,
                    ) ? (
                    <button
                      type="button"
                      className="pg-btn"
                      onClick={() => pause.mutate({ batchRunId: run.id })}
                    >
                      Pause
                    </button>
                  ) : null}
                  {[
                    "pending",
                    "sourcing",
                    "running",
                    "paused",
                    "sinking",
                  ].includes(run.status) ? (
                    <button
                      type="button"
                      className="pg-btn"
                      onClick={() => cancel.mutate({ batchRunId: run.id })}
                    >
                      Cancel
                    </button>
                  ) : null}
                  {run.status === "completed_with_errors" ? (
                    <button
                      type="button"
                      className="pg-btn"
                      onClick={() => retry.mutate({ batchRunId: run.id })}
                    >
                      Retry failed
                    </button>
                  ) : null}
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
