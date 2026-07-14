"use client";

import {
  useBatchItemSteps,
  useBatchRun,
  useBatchRunItems,
  useBatchRuns,
  useCancelBatchRun,
  usePauseBatchRun,
  useResumeBatchRun,
  useRetryFailedBatchItems,
  useTriggerBatchRun,
} from "@catamorphic/react";
import type {
  BatchItem,
  BatchItemStatus,
  BatchRun,
  BatchRunStatus,
  TriggerBatchRunInput,
} from "@catamorphic/react/types";
import { type ReactNode, useState } from "react";

export interface BatchRunsPanelProps {
  projectId: string;
  workflowName: string;
  limit?: number;
  itemLimit?: number;
  triggerInput?: TriggerBatchRunInput;
  onSelectBatchRun?: (input: { batchRun: BatchRun }) => void;
  renderArtifact?: (input: { batchRun: BatchRun }) => ReactNode;
}

const ACTIVE_STATUSES = new Set<BatchRunStatus>([
  "pending",
  "sourcing",
  "running",
  "paused",
  "sinking",
]);

const ITEM_STATUSES = [
  "pending",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "skipped",
  "canceled",
] satisfies readonly BatchItemStatus[];

const RUN_STATUS_TINTS: Record<BatchRunStatus, string> = {
  pending: "text-neutral-400",
  sourcing: "text-cyan-400",
  running: "text-blue-400",
  paused: "text-amber-400",
  sinking: "text-violet-400",
  completed: "text-emerald-400",
  completed_with_errors: "text-amber-400",
  failed: "text-red-400",
  canceled: "text-neutral-500",
};

const ITEM_STATUS_TINTS: Record<BatchItemStatus, string> = {
  pending: "text-neutral-400",
  running: "text-blue-400",
  waiting: "text-cyan-400",
  succeeded: "text-emerald-400",
  failed: "text-red-400",
  skipped: "text-amber-400",
  canceled: "text-neutral-500",
};

function formatStatus({ status }: { status: string }): string {
  return status.replaceAll("_", " ");
}

function metricsFor({ batchRun }: { batchRun: BatchRun }) {
  const processed =
    batchRun.completedCount + batchRun.failedCount + batchRun.skippedCount;
  const total = batchRun.estimatedCount ?? batchRun.discoveredCount;
  const percentage =
    total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;
  const startedAt = batchRun.startedAt
    ? new Date(batchRun.startedAt).getTime()
    : null;
  const endedAt = batchRun.completedAt
    ? new Date(batchRun.completedAt).getTime()
    : Date.now();
  const elapsedSeconds = startedAt
    ? Math.max(1, (endedAt - startedAt) / 1_000)
    : null;
  const throughput = elapsedSeconds ? processed / elapsedSeconds : null;
  const remaining = Math.max(0, total - processed);
  const etaSeconds =
    throughput && throughput > 0 ? Math.ceil(remaining / throughput) : null;

  return { etaSeconds, percentage, processed, throughput, total };
}

function downloadableArtifact(value: unknown): {
  fileName: string;
  contentType: string;
  content: string;
} | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const entries = Object.fromEntries(Object.entries(value));
  if (
    typeof entries.fileName !== "string" ||
    typeof entries.contentType !== "string" ||
    typeof entries.content !== "string"
  ) {
    return null;
  }
  return {
    fileName: entries.fileName,
    contentType: entries.contentType,
    content: entries.content,
  };
}

export function BatchRunsPanel({
  projectId,
  workflowName,
  limit = 20,
  itemLimit = 25,
  triggerInput,
  onSelectBatchRun,
  renderArtifact,
}: BatchRunsPanelProps) {
  const [selectedBatchRunId, setSelectedBatchRunId] = useState<string>();
  const [itemStatus, setItemStatus] = useState<BatchItemStatus>();
  const [itemOffset, setItemOffset] = useState(0);
  const [selectedItemId, setSelectedItemId] = useState<string>();
  const batchRunsQuery = useBatchRuns({
    projectId,
    workflowName,
    limit,
  });
  const selectedId = selectedBatchRunId ?? batchRunsQuery.data?.items[0]?.id;
  const selectedSummary = batchRunsQuery.data?.items.find(
    (batchRun: BatchRun) => batchRun.id === selectedId,
  );
  const batchRunQuery = useBatchRun({ batchRunId: selectedId });
  const batchRun = batchRunQuery.data ?? selectedSummary;
  const isActive = batchRun ? ACTIVE_STATUSES.has(batchRun.status) : false;
  const itemsQuery = useBatchRunItems({
    batchRunId: selectedId,
    status: itemStatus,
    limit: itemLimit,
    offset: itemOffset,
    active: isActive,
  });
  const itemStepsQuery = useBatchItemSteps({
    batchRunId: selectedId,
    itemId: selectedItemId,
    active: isActive,
  });
  const trigger = useTriggerBatchRun({ projectId, workflowName });
  const cancel = useCancelBatchRun({ projectId, workflowName });
  const pause = usePauseBatchRun({ projectId, workflowName });
  const resume = useResumeBatchRun({ projectId, workflowName });
  const retryFailed = useRetryFailedBatchItems({ projectId, workflowName });
  const metrics = batchRun ? metricsFor({ batchRun }) : null;
  const download = downloadableArtifact(batchRun?.artifact);
  const error =
    trigger.error ??
    cancel.error ??
    pause.error ??
    resume.error ??
    retryFailed.error ??
    batchRunsQuery.error ??
    batchRunQuery.error ??
    itemsQuery.error ??
    itemStepsQuery.error;

  const selectBatchRun = ({ nextBatchRun }: { nextBatchRun: BatchRun }) => {
    setSelectedBatchRunId(nextBatchRun.id);
    setSelectedItemId(undefined);
    setItemOffset(0);
    onSelectBatchRun?.({ batchRun: nextBatchRun });
  };

  return (
    <div className="grid min-h-[32rem] grid-cols-1 overflow-hidden rounded-lg border border-neutral-800 bg-neutral-950 lg:grid-cols-[18rem,1fr]">
      <aside className="border-b border-neutral-800 lg:border-r lg:border-b-0">
        <header className="flex items-center justify-between border-b border-neutral-800 px-3 py-2">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-neutral-500">
            Batch runs
          </h3>
          <button
            type="button"
            onClick={() => trigger.mutate(triggerInput)}
            disabled={trigger.isPending}
            className="h-7 cursor-pointer rounded bg-blue-600 px-3 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50"
          >
            {trigger.isPending ? "Starting…" : "Start batch"}
          </button>
        </header>

        {batchRunsQuery.isLoading ? (
          <p className="px-3 py-3 text-xs text-neutral-500">
            Loading batch runs…
          </p>
        ) : null}
        {batchRunsQuery.data?.items.length === 0 ? (
          <p className="px-3 py-3 text-xs text-neutral-500">
            No batch runs yet.
          </p>
        ) : null}
        <ul>
          {batchRunsQuery.data?.items.map((candidate: BatchRun) => (
            <li key={candidate.id} className="border-b border-neutral-900">
              <button
                type="button"
                onClick={() => selectBatchRun({ nextBatchRun: candidate })}
                className={`w-full px-3 py-3 text-left hover:bg-neutral-900 ${
                  candidate.id === selectedId ? "bg-neutral-900" : ""
                }`}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="truncate font-mono text-xs text-neutral-300">
                    {candidate.id.slice(0, 8)}
                  </span>
                  <span
                    className={`text-[10px] uppercase tracking-wider ${
                      RUN_STATUS_TINTS[candidate.status]
                    }`}
                  >
                    {formatStatus({ status: candidate.status })}
                  </span>
                </span>
                <span className="mt-1 block text-[11px] text-neutral-500">
                  {candidate.completedCount} completed ·{" "}
                  {new Date(candidate.createdAt).toLocaleString()}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <section className="min-w-0">
        {!batchRun ? (
          <p className="px-4 py-6 text-sm text-neutral-500">
            Select a batch run to inspect its progress.
          </p>
        ) : (
          <>
            <header className="border-b border-neutral-800 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-mono text-xs text-neutral-400">
                    {batchRun.id}
                  </p>
                  <p
                    className={`mt-1 text-xs font-medium uppercase tracking-wider ${
                      RUN_STATUS_TINTS[batchRun.status]
                    }`}
                  >
                    {formatStatus({ status: batchRun.status })}
                  </p>
                </div>
                <div className="flex gap-2">
                  {batchRun.status === "completed_with_errors" ? (
                    <button
                      type="button"
                      onClick={() =>
                        retryFailed.mutate({ batchRunId: batchRun.id })
                      }
                      disabled={retryFailed.isPending}
                      className="h-8 cursor-pointer rounded border border-neutral-700 px-3 text-xs text-neutral-300 hover:bg-neutral-900 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {retryFailed.isPending
                        ? "Retrying…"
                        : "Retry failed items"}
                    </button>
                  ) : null}
                  {batchRun.status === "paused" ? (
                    <button
                      type="button"
                      onClick={() => resume.mutate({ batchRunId: batchRun.id })}
                      disabled={resume.isPending}
                      className="h-8 cursor-pointer rounded border border-neutral-700 px-3 text-xs text-neutral-300 hover:bg-neutral-900 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {resume.isPending ? "Resuming…" : "Resume"}
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => pause.mutate({ batchRunId: batchRun.id })}
                      disabled={!isActive || pause.isPending}
                      className="h-8 cursor-pointer rounded border border-neutral-700 px-3 text-xs text-neutral-300 hover:bg-neutral-900 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {pause.isPending ? "Pausing…" : "Pause"}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => cancel.mutate({ batchRunId: batchRun.id })}
                    disabled={!isActive || cancel.isPending}
                    className="h-8 cursor-pointer rounded border border-neutral-700 px-3 text-xs text-neutral-300 hover:bg-neutral-900 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {cancel.isPending ? "Canceling…" : "Cancel batch"}
                  </button>
                </div>
              </div>

              {metrics ? (
                <div className="mt-4">
                  <div className="mb-1 flex items-center justify-between text-[11px] text-neutral-500">
                    <span>
                      {metrics.processed} / {metrics.total} processed
                    </span>
                    <span>
                      {metrics.percentage}% ·{" "}
                      {metrics.throughput === null
                        ? "—"
                        : `${metrics.throughput.toFixed(1)} items/s`}
                      {" · "}
                      {metrics.etaSeconds === null
                        ? "ETA —"
                        : `ETA ${metrics.etaSeconds}s`}
                    </span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-neutral-800">
                    <div
                      className="h-full rounded-full bg-blue-500 transition-[width]"
                      style={{ width: `${metrics.percentage}%` }}
                    />
                  </div>
                </div>
              ) : null}

              <dl className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-6">
                {[
                  ["Discovered", batchRun.discoveredCount],
                  ["Completed", batchRun.completedCount],
                  ["Failed", batchRun.failedCount],
                  ["Skipped", batchRun.skippedCount],
                  [
                    "Sink chunks",
                    `${batchRun.sinkCompletedChunks}/${batchRun.sinkTotalChunks}`,
                  ],
                  [
                    "Remaining",
                    Math.max(
                      0,
                      batchRun.discoveredCount -
                        batchRun.completedCount -
                        batchRun.failedCount -
                        batchRun.skippedCount,
                    ),
                  ],
                ].map(([label, value]) => (
                  <div
                    key={label}
                    className="rounded border border-neutral-800 px-2 py-2"
                  >
                    <dt className="text-[10px] uppercase tracking-wider text-neutral-600">
                      {label}
                    </dt>
                    <dd className="mt-1 text-sm font-medium text-neutral-300">
                      {value}
                    </dd>
                  </div>
                ))}
              </dl>

              {batchRun.error ? (
                <p className="mt-3 rounded border border-red-900/60 bg-red-950/30 px-3 py-2 text-xs text-red-300">
                  {batchRun.error}
                </p>
              ) : null}
            </header>

            <div className="border-b border-neutral-800 p-4">
              {renderArtifact ? (
                renderArtifact({ batchRun })
              ) : download ? (
                <a
                  href={`data:${download.contentType};charset=utf-8,${encodeURIComponent(
                    download.content,
                  )}`}
                  download={download.fileName}
                  className="inline-flex h-8 items-center rounded bg-blue-600 px-3 text-xs font-medium text-white hover:bg-blue-500"
                >
                  Download {download.fileName}
                </a>
              ) : batchRun.artifact ? (
                <pre className="overflow-x-auto rounded border border-neutral-800 bg-neutral-900 p-3 text-xs text-neutral-300">
                  {JSON.stringify(batchRun.artifact, null, 2)}
                </pre>
              ) : (
                <div className="rounded border border-dashed border-neutral-800 px-3 py-3 text-xs text-neutral-500">
                  No result artifact is available.
                </div>
              )}
            </div>

            <div className="flex items-center justify-between gap-3 border-b border-neutral-800 px-4 py-2">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-neutral-500">
                Items
              </h4>
              <select
                value={itemStatus ?? ""}
                onChange={(event) => {
                  const nextStatus = ITEM_STATUSES.find(
                    (status) => status === event.currentTarget.value,
                  );
                  setItemStatus(nextStatus);
                  setItemOffset(0);
                  setSelectedItemId(undefined);
                }}
                className="h-7 rounded border border-neutral-700 bg-neutral-900 px-2 text-xs text-neutral-300"
              >
                <option value="">All statuses</option>
                {ITEM_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {formatStatus({ status })}
                  </option>
                ))}
              </select>
            </div>

            {itemsQuery.isLoading ? (
              <p className="px-4 py-3 text-xs text-neutral-500">
                Loading items…
              </p>
            ) : null}
            {itemsQuery.data?.items.length === 0 ? (
              <p className="px-4 py-3 text-xs text-neutral-500">
                No items match this filter.
              </p>
            ) : null}
            <ul className="divide-y divide-neutral-900">
              {itemsQuery.data?.items.map((item: BatchItem) => (
                <li key={item.id} className="px-4 py-3">
                  <button
                    type="button"
                    onClick={() =>
                      setSelectedItemId(
                        selectedItemId === item.id ? undefined : item.id,
                      )
                    }
                    className="grid w-full gap-1 text-left sm:grid-cols-[1fr,auto] sm:gap-3"
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-mono text-xs text-neutral-300">
                        {item.key}
                      </span>
                      <span className="block text-[11px] text-neutral-600">
                        Item {item.sourceOrder + 1} · attempt {item.attempt}
                      </span>
                      {item.error ? (
                        <span className="mt-1 block text-xs text-red-400">
                          {item.error}
                        </span>
                      ) : null}
                    </span>
                    <span
                      className={`text-[10px] uppercase tracking-wider ${
                        ITEM_STATUS_TINTS[item.status]
                      }`}
                    >
                      {formatStatus({ status: item.status })}
                    </span>
                  </button>
                  {selectedItemId === item.id ? (
                    <ol className="mt-3 space-y-2 border-l border-neutral-800 pl-3">
                      {itemStepsQuery.isLoading ? (
                        <li className="text-xs text-neutral-600">
                          Loading step history…
                        </li>
                      ) : null}
                      {itemStepsQuery.data?.map((step) => (
                        <li key={step.id} className="text-xs">
                          <span className="text-neutral-300">{step.name}</span>
                          <span className="ml-2 uppercase text-neutral-600">
                            attempt {step.attempt} ·{" "}
                            {formatStatus({ status: step.status })}
                          </span>
                          {step.error ? (
                            <span className="mt-1 block text-red-400">
                              {step.error}
                            </span>
                          ) : null}
                        </li>
                      ))}
                    </ol>
                  ) : null}
                </li>
              ))}
            </ul>

            {itemsQuery.data && itemsQuery.data.total > itemLimit ? (
              <footer className="flex items-center justify-between border-t border-neutral-800 px-4 py-2">
                <span className="text-[11px] text-neutral-500">
                  {itemOffset + 1}–
                  {Math.min(itemOffset + itemLimit, itemsQuery.data.total)} of{" "}
                  {itemsQuery.data.total}
                </span>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      setItemOffset(Math.max(0, itemOffset - itemLimit))
                    }
                    disabled={itemOffset === 0}
                    className="h-7 rounded border border-neutral-700 px-2 text-xs text-neutral-300 disabled:opacity-40"
                  >
                    Previous
                  </button>
                  <button
                    type="button"
                    onClick={() => setItemOffset(itemOffset + itemLimit)}
                    disabled={itemOffset + itemLimit >= itemsQuery.data.total}
                    className="h-7 rounded border border-neutral-700 px-2 text-xs text-neutral-300 disabled:opacity-40"
                  >
                    Next
                  </button>
                </div>
              </footer>
            ) : null}
          </>
        )}

        {error ? (
          <p className="border-t border-red-900/50 bg-red-950/30 px-4 py-2 text-xs text-red-300">
            {error.message}
          </p>
        ) : null}
      </section>
    </div>
  );
}
