import {
  selectedNodeIdAtom,
  useCancelRun,
  usePauseRunProcessing,
  useResumeRunProcessing,
  useRun,
  useRunItemSteps,
  useRunItems,
  useRuns,
  useSubmitRunInput,
} from "@catamorphic/react";
import type {
  BatchProgress,
  Run,
  RunItemStatus,
  RunPhase,
  RunStatus,
} from "@catamorphic/react/types";
import { useSetAtom } from "jotai";
import { useEffect, useState } from "react";

export interface RunsPanelProps {
  projectId: string;
  workflowName: string;
  limit?: number;
  activeRun?: Run;
}

const STATUS_LABELS: Record<RunStatus, string> = {
  pending: "Pending",
  running: "Running",
  waiting: "Waiting",
  paused: "Paused",
  canceling: "Canceling",
  completed: "Completed",
  failed: "Failed",
  canceled: "Canceled",
};

const STATUS_COLORS: Record<RunStatus, string> = {
  pending: "#a3a3a3",
  running: "#60a5fa",
  waiting: "#fbbf24",
  paused: "#f59e0b",
  canceling: "#a3a3a3",
  completed: "#4ade80",
  failed: "#f87171",
  canceled: "#737373",
};

const PHASE_LABELS: Record<RunPhase, string> = {
  execute: "Workflow",
  boundary: "Retry scope",
  source: "Batch processing",
  process: "Batch processing",
  sink: "Batch processing",
  pause: "Waiting for input",
  child: "Child Workflow",
};

const ITEM_STATUSES = [
  "pending",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "skipped",
  "canceled",
] satisfies RunItemStatus[];

function formatDuration(startedAt: string | null, completedAt: string | null) {
  if (!startedAt) return "Not started";
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  const elapsed = Math.max(0, end - new Date(startedAt).getTime());
  return elapsed < 1_000 ? `${elapsed}ms` : `${(elapsed / 1_000).toFixed(1)}s`;
}

function JsonView({ value }: { value: unknown }) {
  if (value === undefined || value === null) return null;
  return (
    <pre className="catamorphic-run-json">
      {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
    </pre>
  );
}

function StatusBadge({ run }: { run: Run }) {
  const label =
    run.status === "waiting" && run.phase === "pause"
      ? "Waiting for input"
      : STATUS_LABELS[run.status];
  const color = STATUS_COLORS[run.status];
  return (
    <span className="catamorphic-run-status" style={{ color }}>
      <span
        className="catamorphic-run-status-dot"
        style={{ background: color }}
      />
      {label}
    </span>
  );
}

function RunControls({ run }: { run: Run }) {
  const cancel = useCancelRun({ runId: run.id });
  const pause = usePauseRunProcessing({ runId: run.id });
  const resume = useResumeRunProcessing({ runId: run.id });
  const submit = useSubmitRunInput({
    runId: run.id,
    pauseId: run.activePause?.id ?? "",
  });
  const [input, setInput] = useState("{}");
  const [inputError, setInputError] = useState<string>();
  const error = cancel.error ?? pause.error ?? resume.error ?? submit.error;

  return (
    <div className="catamorphic-run-controls">
      {run.capabilities.submitInput && run.activePause ? (
        <div className="catamorphic-run-input-action">
          <div>
            <strong>Waiting for input</strong>
            {run.activePause.timeoutAt ? (
              <span className="catamorphic-run-input-deadline">
                Deadline {new Date(run.activePause.timeoutAt).toLocaleString()}
              </span>
            ) : null}
          </div>
          {run.activePause.state !== null ? (
            <JsonView value={run.activePause.state} />
          ) : null}
          <textarea
            className="catamorphic-run-textarea"
            value={input}
            onChange={(event) => {
              setInput(event.currentTarget.value);
              setInputError(undefined);
            }}
            rows={4}
            aria-label="Run input"
            spellCheck={false}
          />
          {inputError ? (
            <span className="catamorphic-run-inline-error">{inputError}</span>
          ) : null}
          <button
            type="button"
            className="catamorphic-run-action catamorphic-run-action-primary"
            disabled={submit.isPending}
            onClick={() => {
              try {
                const value = JSON.parse(input);
                submit.mutate({
                  idempotencyKey: crypto.randomUUID(),
                  value,
                });
              } catch {
                setInputError("Enter valid JSON before submitting.");
              }
            }}
          >
            {submit.isPending ? "Submitting..." : "Submit input"}
          </button>
        </div>
      ) : null}
      <div className="catamorphic-run-control-row">
        {run.capabilities.pauseProcessing ? (
          <button
            type="button"
            className="catamorphic-run-action"
            disabled={pause.isPending}
            onClick={() => pause.mutate()}
          >
            {pause.isPending ? "Pausing..." : "Pause processing"}
          </button>
        ) : null}
        {run.capabilities.resumeProcessing ? (
          <button
            type="button"
            className="catamorphic-run-action"
            disabled={resume.isPending}
            onClick={() => resume.mutate()}
          >
            {resume.isPending ? "Resuming..." : "Resume processing"}
          </button>
        ) : null}
        {run.capabilities.cancel ? (
          <button
            type="button"
            className="catamorphic-run-action catamorphic-run-action-danger"
            disabled={cancel.isPending}
            onClick={() => cancel.mutate(undefined)}
          >
            {cancel.isPending ? "Canceling..." : "Cancel Run"}
          </button>
        ) : null}
      </div>
      {error ? (
        <span className="catamorphic-run-inline-error">{error.message}</span>
      ) : null}
    </div>
  );
}

function BatchScopeProgress({ progress }: { progress: BatchProgress }) {
  const processed = progress.succeeded + progress.failed + progress.skipped;
  const total = progress.estimated ?? progress.discovered;
  const percentage = total > 0 ? Math.min(100, (processed / total) * 100) : 0;

  return (
    <section className="catamorphic-run-section">
      <div className="catamorphic-run-section-heading">
        <strong>Batch processing, step {progress.stepIndex + 1}</strong>
        <span>
          {processed} of {total} Items
        </span>
      </div>
      <div
        className="catamorphic-run-progress"
        role="progressbar"
        aria-label="Batch processing progress"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={processed}
      >
        <div style={{ width: `${percentage}%` }} />
      </div>
      <dl className="catamorphic-run-metrics">
        <div>
          <dt>Discovered</dt>
          <dd>{progress.discovered}</dd>
        </div>
        <div>
          <dt>Succeeded</dt>
          <dd>{progress.succeeded}</dd>
        </div>
        <div>
          <dt>Failed</dt>
          <dd>{progress.failed}</dd>
        </div>
        <div>
          <dt>Skipped</dt>
          <dd>{progress.skipped}</dd>
        </div>
      </dl>
      {progress.artifact !== null ? (
        <div>
          <span className="catamorphic-detail-section-label">Result</span>
          <JsonView value={progress.artifact} />
        </div>
      ) : null}
    </section>
  );
}

function RunItems({ run, scope }: { run: Run; scope: BatchProgress }) {
  const attemptId = scope.workflowStepAttemptId;
  const [status, setStatus] = useState<RunItemStatus>();
  const [offset, setOffset] = useState(0);
  const [selectedItemId, setSelectedItemId] = useState<string>();
  const items = useRunItems({
    run,
    workflowStepAttemptId: attemptId,
    status,
    limit: 25,
    offset,
  });
  const itemSteps = useRunItemSteps({
    run,
    workflowStepAttemptId: attemptId,
    itemId: selectedItemId,
  });

  if (!run.capabilities.inspectItems) return null;
  return (
    <section className="catamorphic-run-section">
      <div className="catamorphic-run-section-heading">
        <strong>Items</strong>
        <select
          className="catamorphic-run-select"
          value={status ?? ""}
          onChange={(event) => {
            const next = ITEM_STATUSES.find(
              (candidate) => candidate === event.currentTarget.value,
            );
            setStatus(next);
            setOffset(0);
            setSelectedItemId(undefined);
          }}
        >
          <option value="">All statuses</option>
          {ITEM_STATUSES.map((candidate) => (
            <option key={candidate} value={candidate}>
              {candidate.replaceAll("_", " ")}
            </option>
          ))}
        </select>
      </div>
      {items.isLoading ? (
        <span className="catamorphic-runs-loading">Loading Items...</span>
      ) : null}
      {items.data?.items.length === 0 ? (
        <span className="catamorphic-runs-loading">No Items match.</span>
      ) : null}
      <div className="catamorphic-run-items">
        {items.data?.items.map((item) => (
          <div className="catamorphic-run-item" key={item.id}>
            <button
              type="button"
              onClick={() =>
                setSelectedItemId((current) =>
                  current === item.id ? undefined : item.id,
                )
              }
            >
              <span>
                <strong>{item.key}</strong>
                <small>
                  Item {item.sourceOrder + 1}, attempt {item.attempt}
                </small>
              </span>
              <span>{item.status}</span>
            </button>
            {item.error ? (
              <pre className="catamorphic-run-error-text">{item.error}</pre>
            ) : null}
            {selectedItemId === item.id ? (
              <div className="catamorphic-run-item-history">
                <span className="catamorphic-detail-section-label">
                  Item history
                </span>
                {itemSteps.isLoading ? <span>Loading...</span> : null}
                {itemSteps.data?.map((step) => (
                  <div key={step.id}>
                    <strong>{step.name}</strong>
                    <span>
                      Attempt {step.attempt}, {step.status}
                    </span>
                    {step.error ? <small>{step.error}</small> : null}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ))}
      </div>
      {items.data && items.data.total > 25 ? (
        <div className="catamorphic-run-pagination">
          <button
            type="button"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - 25))}
          >
            Previous
          </button>
          <span>
            {offset + 1}-{Math.min(offset + 25, items.data.total)} of{" "}
            {items.data.total}
          </span>
          <button
            type="button"
            disabled={offset + 25 >= items.data.total}
            onClick={() => setOffset(offset + 25)}
          >
            Next
          </button>
        </div>
      ) : null}
      {items.error ? (
        <span className="catamorphic-run-inline-error">
          {items.error.message}
        </span>
      ) : null}
    </section>
  );
}

function BatchScopes({ run }: { run: Run }) {
  const [selectedScopeId, setSelectedScopeId] = useState<string>();
  const currentScope = run.batchScopes
    .filter((scope) => scope.stepIndex === run.currentStepIndex)
    .at(-1);
  const latestScope = run.batchScopes.at(-1);
  const selectedScope =
    run.batchScopes.find(
      (scope) => scope.workflowStepAttemptId === selectedScopeId,
    ) ??
    currentScope ??
    latestScope;

  if (!selectedScope) return null;
  return (
    <>
      <section className="catamorphic-run-section">
        <div className="catamorphic-run-section-heading">
          <strong>Batch processing</strong>
          <select
            aria-label="Batch processing scope"
            className="catamorphic-run-select"
            value={selectedScope.workflowStepAttemptId}
            onChange={(event) => setSelectedScopeId(event.currentTarget.value)}
          >
            {run.batchScopes.map((scope) => (
              <option
                key={scope.workflowStepAttemptId}
                value={scope.workflowStepAttemptId}
              >
                Batch processing, step {scope.stepIndex + 1}, attempt{" "}
                {scope.attempt}
              </option>
            ))}
          </select>
        </div>
      </section>
      <BatchScopeProgress progress={selectedScope} />
      <RunItems
        key={selectedScope.workflowStepAttemptId}
        run={run}
        scope={selectedScope}
      />
    </>
  );
}

function RunDetail({ runId }: { runId: string }) {
  const runQuery = useRun({ runId });
  const setSelectedNodeId = useSetAtom(selectedNodeIdAtom);
  const run = runQuery.data;
  if (runQuery.isLoading || !run) {
    return <div className="catamorphic-run-detail-empty">Loading Run...</div>;
  }

  return (
    <div className="catamorphic-run-detail">
      <header className="catamorphic-run-detail-header">
        <div>
          <span className="catamorphic-run-id">{run.id}</span>
          <div className="catamorphic-run-detail-state">
            <StatusBadge run={run} />
            {!(["completed", "failed", "canceled"] as RunStatus[]).includes(
              run.status,
            ) ? (
              <span>{PHASE_LABELS[run.phase]}</span>
            ) : null}
          </div>
        </div>
        <span className="catamorphic-run-duration">
          {formatDuration(run.startedAt, run.completedAt)}
        </span>
      </header>
      <RunControls run={run} />
      {run.error ? (
        <pre className="catamorphic-run-error-text">{run.error}</pre>
      ) : null}
      {run.result !== null ? (
        <section className="catamorphic-run-section">
          <strong>Result</strong>
          <JsonView value={run.result} />
        </section>
      ) : null}
      <BatchScopes run={run} />
      {run.workflowStepAttempts.length > 0 ? (
        <section className="catamorphic-run-section">
          <strong>Run history</strong>
          <div className="catamorphic-run-attempts">
            {run.workflowStepAttempts.map((attempt) => (
              <button
                type="button"
                key={attempt.id}
                onClick={() => setSelectedNodeId(attempt.nodeId)}
              >
                <span>
                  {attempt.executor === "batch"
                    ? "Batch processing"
                    : "Retry scope"}
                </span>
                <span>
                  Attempt {attempt.attempt}, {attempt.status}
                </span>
              </button>
            ))}
          </div>
        </section>
      ) : null}
      {run.steps.length > 0 ? (
        <section className="catamorphic-run-section">
          <strong>Steps</strong>
          <div className="catamorphic-run-attempts">
            {run.steps.map((step) => (
              <button
                type="button"
                key={step.id}
                onClick={() => setSelectedNodeId(step.nodeId)}
              >
                <span>{step.name}</span>
                <span>
                  Attempt {step.attempt}, {step.status}
                </span>
              </button>
            ))}
          </div>
        </section>
      ) : null}
      {runQuery.error ? (
        <span className="catamorphic-run-inline-error">
          {runQuery.error.message}
        </span>
      ) : null}
    </div>
  );
}

export function RunsPanel({
  projectId,
  workflowName,
  limit = 25,
  activeRun,
}: RunsPanelProps) {
  const runs = useRuns({ projectId, workflowName, limit });
  const [selectedRunId, setSelectedRunId] = useState<string>();
  const listedRuns = runs.data?.items ?? [];
  const activeRunListed = activeRun
    ? listedRuns.some((run) => run.id === activeRun.id)
    : false;
  const visibleRuns =
    activeRun && !activeRunListed ? [activeRun, ...listedRuns] : listedRuns;
  const selectedId = selectedRunId ?? visibleRuns[0]?.id;

  useEffect(() => {
    if (activeRun) setSelectedRunId(activeRun.id);
  }, [activeRun]);

  useEffect(() => {
    if (
      selectedRunId &&
      runs.data &&
      !runs.data.items.some((run) => run.id === selectedRunId) &&
      activeRun?.id !== selectedRunId
    ) {
      setSelectedRunId(undefined);
    }
  }, [activeRun?.id, runs.data, selectedRunId]);

  return (
    <div className="catamorphic-runs-panel">
      <aside className="catamorphic-runs-list">
        <div className="catamorphic-runs-list-heading">Runs</div>
        {runs.isLoading ? (
          <span className="catamorphic-runs-loading">Loading Runs...</span>
        ) : null}
        {visibleRuns.length === 0 ? (
          <div className="catamorphic-run-empty">
            <p>No Runs yet</p>
            <p className="catamorphic-run-empty-hint">
              Run this Workflow to see its history.
            </p>
          </div>
        ) : null}
        {visibleRuns.map((run) => (
          <button
            type="button"
            key={run.id}
            className={`catamorphic-runs-list-row${run.id === selectedId ? " is-selected" : ""}`}
            onClick={() => setSelectedRunId(run.id)}
          >
            <span>
              <StatusBadge run={run} />
              <small>{run.mode === "test" ? "Test Run" : "Production"}</small>
            </span>
            <span>
              {new Date(run.createdAt).toLocaleString([], {
                dateStyle: "short",
                timeStyle: "short",
              })}
            </span>
          </button>
        ))}
        {runs.error ? (
          <span className="catamorphic-run-inline-error">
            {runs.error.message}
          </span>
        ) : null}
      </aside>
      <main className="catamorphic-runs-detail-pane">
        {selectedId ? (
          <RunDetail runId={selectedId} />
        ) : (
          <div className="catamorphic-run-detail-empty">
            Select a Run to inspect it.
          </div>
        )}
      </main>
    </div>
  );
}
