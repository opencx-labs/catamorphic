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
        <strong className="text-xs text-neutral-200">Items</strong>
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
          className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-300"
        >
          <option value="">All statuses</option>
          {ITEM_STATUSES.map((status) => (
            <option key={status} value={status}>
              {label(status)}
            </option>
          ))}
        </select>
      </div>
      <div className="divide-y divide-neutral-900">
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
              <span className="min-w-0 truncate font-mono text-neutral-300">
                {item.key}
              </span>
              <span className="capitalize text-neutral-500">
                {label(item.status)}
              </span>
            </button>
            {selectedItemId === item.id ? (
              <div className="mt-2 space-y-1 border-l border-neutral-800 pl-3 text-xs">
                <p className="uppercase tracking-wider text-neutral-600">
                  Item history
                </p>
                {itemSteps.data?.map((step) => (
                  <p key={step.id} className="text-neutral-400">
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
    return <p className="p-4 text-xs text-neutral-500">Loading Run...</p>;
  }
  const progress = selectedScope;
  const processed = progress
    ? progress.succeeded + progress.failed + progress.skipped
    : 0;
  const total = progress ? (progress.estimated ?? progress.discovered) : 0;

  return (
    <div className="min-w-0 divide-y divide-neutral-800">
      <header className="space-y-3 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="break-all font-mono text-xs text-neutral-400">
              {run.id}
            </p>
            <p className="mt-1 text-xs font-medium capitalize text-neutral-200">
              {run.status === "waiting" && run.phase === "pause"
                ? "Waiting for input"
                : label(run.status)}
            </p>
            {!(["completed", "failed", "canceled"] as string[]).includes(
              run.status,
            ) ? (
              <p className="mt-1 text-[11px] capitalize text-neutral-500">
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
                className="rounded border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300"
              >
                Pause processing
              </button>
            ) : null}
            {run.capabilities.resumeProcessing ? (
              <button
                type="button"
                onClick={() => resume.mutate()}
                className="rounded border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300"
              >
                Resume processing
              </button>
            ) : null}
            {run.capabilities.cancel ? (
              <button
                type="button"
                onClick={() => cancel.mutate(undefined)}
                className="rounded border border-red-900 px-3 py-1.5 text-xs text-red-300"
              >
                Cancel Run
              </button>
            ) : null}
          </div>
        </div>
        {run.capabilities.submitInput && run.activePause ? (
          <div className="grid gap-2 rounded border border-amber-900/60 bg-amber-950/20 p-3">
            <strong className="text-xs text-amber-200">
              Waiting for input
            </strong>
            <textarea
              value={input}
              onChange={(event) => setInput(event.currentTarget.value)}
              rows={4}
              className="rounded border border-neutral-700 bg-neutral-950 p-2 font-mono text-xs text-neutral-200"
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
              className="w-fit rounded bg-blue-600 px-3 py-1.5 text-xs text-white"
            >
              Submit input
            </button>
          </div>
        ) : null}
      </header>

      {progress ? (
        <section className="space-y-3 p-4">
          <div className="flex justify-between gap-3 text-xs">
            <strong className="text-neutral-200">
              Batch processing, step {progress.stepIndex + 1}
            </strong>
            <span className="text-neutral-500">
              {processed} / {total} Items
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-neutral-800">
            <div
              className="h-full bg-blue-500"
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
              <div key={name} className="rounded border border-neutral-800 p-2">
                <dt className="text-[10px] uppercase text-neutral-600">
                  {name}
                </dt>
                <dd className="mt-1 text-neutral-300">{value}</dd>
              </div>
            ))}
          </dl>
          <label className="grid gap-1 text-[10px] uppercase text-neutral-600">
            Batch processing
            <select
              aria-label="Batch processing scope"
              value={progress.workflowStepAttemptId}
              onChange={(event) =>
                setSelectedScopeId(event.currentTarget.value)
              }
              className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs normal-case text-neutral-300"
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
}: RunsPanelProps) {
  const runs = useRuns({ projectId, workflowName, limit });
  const trigger = useTriggerRun({ projectId, workflowName });
  const [selectedRunId, setSelectedRunId] = useState<string>();
  const selectedId = selectedRunId ?? runs.data?.items[0]?.id;

  return (
    <div className="grid min-h-[32rem] grid-cols-1 overflow-hidden rounded-lg border border-neutral-800 bg-neutral-950 lg:grid-cols-[18rem,minmax(0,1fr)]">
      <aside className="border-b border-neutral-800 lg:border-r lg:border-b-0">
        <header className="flex items-center justify-between border-b border-neutral-800 px-3 py-2">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-neutral-500">
            Runs
          </h3>
          <button
            type="button"
            onClick={() => trigger.mutate({ input })}
            disabled={trigger.isPending}
            className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
          >
            {trigger.isPending ? "Starting..." : "Run"}
          </button>
        </header>
        {runs.data?.items.map((run) => (
          <button
            type="button"
            key={run.id}
            onClick={() => {
              setSelectedRunId(run.id);
              onSelectRun?.(run);
            }}
            className={`block w-full border-b border-neutral-900 px-3 py-3 text-left ${run.id === selectedId ? "bg-neutral-900" : "hover:bg-neutral-900"}`}
          >
            <span className="flex justify-between gap-2 text-xs">
              <span className="font-mono text-neutral-300">
                {run.id.slice(0, 8)}
              </span>
              <span className="capitalize text-neutral-500">
                {run.status === "waiting" && run.phase === "pause"
                  ? "Waiting for input"
                  : label(run.status)}
              </span>
            </span>
            <span className="mt-1 block text-[11px] text-neutral-600">
              {new Date(run.createdAt).toLocaleString()}
            </span>
          </button>
        ))}
      </aside>
      <main className="min-w-0">
        {selectedId ? (
          <RunDetail runId={selectedId} />
        ) : (
          <p className="p-4 text-sm text-neutral-500">
            Run this Workflow to see its history.
          </p>
        )}
      </main>
    </div>
  );
}
