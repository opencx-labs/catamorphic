"use client";

import {
  useCancelRun,
  usePauseRunProcessing,
  useResumeRunProcessing,
  useRun,
  useRunItemSteps,
  useRunItems,
  useRuns,
  useSubmitRunInput,
  useTriggerRun,
  useTriggerTestRun,
} from "@catamorphic/react";
import type {
  BatchProgress,
  Run,
  RunItemStatus,
} from "@catamorphic/react/types";
import { useState } from "react";

export interface RunsPanelProps {
  projectId: string;
  workflowName: string;
  limit?: number;
  input?: Record<string, unknown>;
  onSelectRun?: (run: Run) => void;
  /**
   * Which kind of run the Run button starts. Production runs require a
   * deployed workflow; hosts without a deploy step (dev-sandbox-only
   * surfaces) should pass `test`.
   */
  runMode?: "production" | "test";
}

const ITEM_STATUSES = [
  "pending",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "skipped",
  "canceled",
] satisfies RunItemStatus[];

function JsonBlock({ label, value }: { label: string; value: unknown }) {
  const text =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return (
    <div className="rounded border border-border bg-bg-raised/60 p-3">
      <p className="text-[10px] uppercase tracking-wider text-fg-faint">
        {label}
      </p>
      <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs text-fg">
        {text}
      </pre>
    </div>
  );
}

function label(value: string) {
  return value.replaceAll("_", " ");
}

function RunItems({ run, scope }: { run: Run; scope: BatchProgress }) {
  const [itemStatus, setItemStatus] = useState<RunItemStatus>();
  const [selectedItemId, setSelectedItemId] = useState<string>();
  const items = useRunItems({
    run,
    workflowStepAttemptId: scope.workflowStepAttemptId,
    status: itemStatus,
    limit: 25,
  });
  const itemSteps = useRunItemSteps({
    run,
    workflowStepAttemptId: scope.workflowStepAttemptId,
    itemId: selectedItemId,
  });

  return (
    <section className="p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <strong className="text-xs text-fg">Items</strong>
        <select
          value={itemStatus ?? ""}
          onChange={(event) => {
            setItemStatus(
              ITEM_STATUSES.find(
                (candidate) => candidate === event.currentTarget.value,
              ),
            );
            setSelectedItemId(undefined);
          }}
          className="rounded border border-border-strong bg-bg-overlay px-2 py-1 text-xs text-fg"
        >
          <option value="">All statuses</option>
          {ITEM_STATUSES.map((status) => (
            <option key={status} value={status}>
              {label(status)}
            </option>
          ))}
        </select>
      </div>
      <div className="divide-y divide-border">
        {items.data?.items.map((item) => (
          <div key={item.id} className="py-2">
            <button
              type="button"
              onClick={() =>
                setSelectedItemId(
                  selectedItemId === item.id ? undefined : item.id,
                )
              }
              className="flex w-full items-center justify-between gap-3 text-left text-xs"
            >
              <span className="min-w-0 truncate font-mono text-fg">
                {item.key}
              </span>
              <span className="capitalize text-fg-muted">
                {label(item.status)}
              </span>
            </button>
            {selectedItemId === item.id ? (
              <div className="mt-2 space-y-1 border-l border-border pl-3 text-xs">
                <p className="uppercase tracking-wider text-fg-faint">
                  Item history
                </p>
                {itemSteps.data?.map((step) => (
                  <p key={step.id} className="text-fg-muted">
                    {step.name}, attempt {step.attempt}, {label(step.status)}
                  </p>
                ))}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}

function RunDetail({ runId }: { runId: string }) {
  const runQuery = useRun({ runId });
  const run = runQuery.data;
  const cancel = useCancelRun({ runId });
  const pause = usePauseRunProcessing({ runId });
  const resume = useResumeRunProcessing({ runId });
  const submit = useSubmitRunInput({
    runId,
    pauseId: run?.activePause?.id ?? "",
  });
  const [input, setInput] = useState("{}");
  const [selectedScopeId, setSelectedScopeId] = useState<string>();
  const currentScope = run?.batchScopes
    .filter((scope) => scope.stepIndex === run.currentStepIndex)
    .at(-1);
  const selectedScope =
    run?.batchScopes.find(
      (scope) => scope.workflowStepAttemptId === selectedScopeId,
    ) ??
    currentScope ??
    run?.batchScopes.at(-1);
  if (!run) {
    return <p className="p-4 text-xs text-fg-muted">Loading Run...</p>;
  }
  const progress = selectedScope;
  const processed = progress
    ? progress.succeeded + progress.failed + progress.skipped
    : 0;
  const total = progress ? (progress.estimated ?? progress.discovered) : 0;

  return (
    <div className="min-w-0 divide-y divide-border">
      <header className="space-y-3 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="break-all font-mono text-xs text-fg-muted">
              {run.id}
            </p>
            <p className="mt-1 text-xs font-medium capitalize text-fg">
              {run.status === "waiting" && run.phase === "pause"
                ? "Waiting for input"
                : label(run.status)}
            </p>
            {!(["completed", "failed", "canceled"] as string[]).includes(
              run.status,
            ) ? (
              <p className="mt-1 text-[11px] capitalize text-fg-muted">
                {run.phase === "boundary"
                  ? "Retry scope"
                  : ["source", "process", "sink"].includes(run.phase)
                    ? "Batch processing"
                    : label(run.phase)}
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-2">
            {run.capabilities.pauseProcessing ? (
              <button
                type="button"
                onClick={() => pause.mutate()}
                className="rounded border border-border-strong px-3 py-1.5 text-xs text-fg"
              >
                Pause processing
              </button>
            ) : null}
            {run.capabilities.resumeProcessing ? (
              <button
                type="button"
                onClick={() => resume.mutate()}
                className="rounded border border-border-strong px-3 py-1.5 text-xs text-fg"
              >
                Resume processing
              </button>
            ) : null}
            {run.capabilities.cancel ? (
              <button
                type="button"
                onClick={() => cancel.mutate(undefined)}
                className="rounded border border-danger/50 px-3 py-1.5 text-xs text-danger"
              >
                Cancel Run
              </button>
            ) : null}
          </div>
        </div>
        {run.input !== null && run.input !== undefined ? (
          <JsonBlock label="Input" value={run.input} />
        ) : null}
        {run.status === "completed" && run.result !== undefined ? (
          <JsonBlock label="Result" value={run.result} />
        ) : null}
        {run.error ? (
          <div className="rounded border border-danger/50 bg-danger/10 p-3">
            <p className="text-[10px] uppercase tracking-wider text-danger">
              Error
            </p>
            <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs text-danger">
              {run.error}
            </pre>
          </div>
        ) : null}
        {run.capabilities.submitInput && run.activePause ? (
          <div className="grid gap-2 rounded border border-warning/50 bg-warning/10 p-3">
            <strong className="text-xs text-warning">Waiting for input</strong>
            <textarea
              value={input}
              onChange={(event) => setInput(event.currentTarget.value)}
              rows={4}
              className="rounded border border-border-strong bg-bg-inset p-2 font-mono text-xs text-fg"
            />
            <button
              type="button"
              onClick={() => {
                try {
                  submit.mutate({
                    idempotencyKey: crypto.randomUUID(),
                    value: JSON.parse(input),
                  });
                } catch {
                  return;
                }
              }}
              className="w-fit rounded bg-accent px-3 py-1.5 text-xs text-accent-fg"
            >
              Submit input
            </button>
          </div>
        ) : null}
      </header>

      {progress ? (
        <section className="space-y-3 p-4">
          <div className="flex justify-between gap-3 text-xs">
            <strong className="text-fg">
              Batch processing, step {progress.stepIndex + 1}
            </strong>
            <span className="text-fg-muted">
              {processed} / {total} Items
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-bg-overlay">
            <div
              className="h-full bg-accent"
              style={{ width: `${total > 0 ? (processed / total) * 100 : 0}%` }}
            />
          </div>
          <dl className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
            {[
              ["Discovered", progress.discovered],
              ["Succeeded", progress.succeeded],
              ["Failed", progress.failed],
              ["Skipped", progress.skipped],
            ].map(([name, value]) => (
              <div key={name} className="rounded border border-border p-2">
                <dt className="text-[10px] uppercase text-fg-faint">{name}</dt>
                <dd className="mt-1 text-fg">{value}</dd>
              </div>
            ))}
          </dl>
          <label className="grid gap-1 text-[10px] uppercase text-fg-faint">
            Batch processing
            <select
              aria-label="Batch processing scope"
              value={progress.workflowStepAttemptId}
              onChange={(event) =>
                setSelectedScopeId(event.currentTarget.value)
              }
              className="rounded border border-border-strong bg-bg-overlay px-2 py-1 text-xs normal-case text-fg"
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
          </label>
        </section>
      ) : null}

      {run.capabilities.inspectItems && progress ? (
        <RunItems
          key={progress.workflowStepAttemptId}
          run={run}
          scope={progress}
        />
      ) : null}
    </div>
  );
}

export function RunsPanel({
  projectId,
  workflowName,
  limit = 25,
  input,
  onSelectRun,
  runMode = "production",
}: RunsPanelProps) {
  const runs = useRuns({ projectId, workflowName, limit });
  const triggerProduction = useTriggerRun({ projectId, workflowName });
  const triggerTest = useTriggerTestRun({ projectId, workflowName });
  const trigger = runMode === "test" ? triggerTest : triggerProduction;
  const [selectedRunId, setSelectedRunId] = useState<string>();
  const selectedId = selectedRunId ?? runs.data?.items[0]?.id;
  const [inputDraft, setInputDraft] = useState(() =>
    input ? JSON.stringify(input, null, 2) : "{}",
  );
  const [inputError, setInputError] = useState(false);

  const startRun = () => {
    let parsed: Record<string, unknown> | undefined;
    try {
      parsed = inputDraft.trim() ? JSON.parse(inputDraft) : undefined;
    } catch {
      setInputError(true);
      return;
    }
    setInputError(false);
    trigger.mutate({ input: parsed });
  };

  return (
    <div className="grid min-h-[32rem] grid-cols-1 overflow-hidden rounded-lg border border-border bg-bg-inset lg:grid-cols-[18rem,minmax(0,1fr)]">
      <aside className="border-b border-border lg:border-r lg:border-b-0">
        <header className="flex items-center justify-between border-b border-border px-3 py-2">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-fg-muted">
            Runs
          </h3>
          <button
            type="button"
            onClick={startRun}
            disabled={trigger.isPending}
            className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg disabled:opacity-50"
          >
            {trigger.isPending ? "Starting..." : "Run"}
          </button>
        </header>
        <div className="border-b border-border px-3 py-2">
          <label className="grid gap-1 text-[10px] uppercase tracking-wider text-fg-faint">
            Input
            <textarea
              value={inputDraft}
              onChange={(event) => {
                setInputDraft(event.currentTarget.value);
                setInputError(false);
              }}
              rows={2}
              spellCheck={false}
              className={`resize-y rounded border bg-bg-inset p-2 font-mono text-xs normal-case text-fg ${
                inputError ? "border-danger/60" : "border-border"
              }`}
            />
          </label>
          {inputError ? (
            <p className="mt-1 text-xs text-danger">
              Input must be valid JSON.
            </p>
          ) : null}
        </div>
        {trigger.error ? (
          <p className="border-b border-danger/50 bg-danger/10 px-3 py-2 text-xs text-danger">
            {trigger.error.message}
          </p>
        ) : null}
        {runs.data?.items.map((run) => (
          <button
            type="button"
            key={run.id}
            onClick={() => {
              setSelectedRunId(run.id);
              onSelectRun?.(run);
            }}
            className={`block w-full border-b border-border px-3 py-3 text-left ${run.id === selectedId ? "bg-bg-overlay" : "hover:bg-bg-overlay"}`}
          >
            <span className="flex justify-between gap-2 text-xs">
              <span className="font-mono text-fg">{run.id.slice(0, 8)}</span>
              <span className="capitalize text-fg-muted">
                {run.status === "waiting" && run.phase === "pause"
                  ? "Waiting for input"
                  : label(run.status)}
              </span>
            </span>
            <span className="mt-1 block text-[11px] text-fg-faint">
              {new Date(run.createdAt).toLocaleString()}
            </span>
          </button>
        ))}
      </aside>
      <main className="min-w-0">
        {selectedId ? (
          <RunDetail runId={selectedId} />
        ) : (
          <p className="p-4 text-sm text-fg-muted">
            Run this Workflow to see its history.
          </p>
        )}
      </main>
    </div>
  );
}
