import { useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  activeRunIdAtom,
  loadMoreRunsAtom,
  runsAtom,
  selectedNodeIdAtom,
} from "./atoms.js";
import type { PlaygroundRun, PlaygroundRunStep } from "./run-types.js";

function StatusBadge({ status }: { status: string }) {
  const config: Record<string, { color: string; label: string }> = {
    completed: { color: "#22c55e", label: "Completed" },
    failed: { color: "#ef4444", label: "Failed" },
    running: { color: "#3b82f6", label: "Running" },
    pending: { color: "#737373", label: "Pending" },
    skipped: { color: "#a3a3a3", label: "Skipped" },
  };
  const { color, label } = config[status] ?? {
    color: "#737373",
    label: status,
  };

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

function StatusDot({ status }: { status: string }) {
  const colors: Record<string, string> = {
    completed: "#22c55e",
    failed: "#ef4444",
    running: "#3b82f6",
    pending: "#737373",
    skipped: "#a3a3a3",
  };
  return (
    <span
      className="catamorphic-run-status-dot"
      style={{ background: colors[status] ?? "#737373" }}
    />
  );
}

function formatDuration(startedAt: string, completedAt?: string): string {
  if (!completedAt) return "...";
  const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function JsonView({ data }: { data: unknown }) {
  if (data === undefined || data === null) return null;
  return (
    <pre className="catamorphic-run-json">
      {typeof data === "string" ? data : JSON.stringify(data, null, 2)}
    </pre>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="catamorphic-run-chevron"
      style={{
        transform: open ? "rotate(90deg)" : "rotate(0deg)",
        transition: "transform 0.15s",
        flexShrink: 0,
      }}
      role="img"
      aria-label={open ? "Collapse" : "Expand"}
    >
      <polyline points="4 2 8 6 4 10" />
    </svg>
  );
}

function StepRow({ step }: { step: PlaygroundRunStep }) {
  const [expanded, setExpanded] = useState(false);
  const setSelectedNodeId = useSetAtom(selectedNodeIdAtom);
  const hasDetails =
    step.input !== undefined || step.output !== undefined || !!step.error;

  const handleClick = useCallback(() => {
    setSelectedNodeId(step.nodeId);
    if (hasDetails) setExpanded((v) => !v);
  }, [step.nodeId, setSelectedNodeId, hasDetails]);

  return (
    <div className="catamorphic-run-tree-step">
      <button
        type="button"
        className="catamorphic-run-tree-step-row"
        onClick={handleClick}
      >
        <span className="catamorphic-run-tree-guide" />
        {hasDetails ? (
          <Chevron open={expanded} />
        ) : (
          <span style={{ width: 12, flexShrink: 0 }} />
        )}
        <StatusDot status={step.status} />
        <span className="catamorphic-run-tree-step-name">{step.name}</span>
        <span className="catamorphic-run-step-duration">
          {formatDuration(step.startedAt, step.completedAt)}
        </span>
      </button>
      {expanded && (
        <div className="catamorphic-run-tree-step-details">
          {step.input !== undefined && (
            <div className="catamorphic-run-step-section">
              <span className="catamorphic-detail-section-label">Input</span>
              <JsonView data={step.input} />
            </div>
          )}
          {step.output !== undefined && (
            <div className="catamorphic-run-step-section">
              <span className="catamorphic-detail-section-label">Output</span>
              <JsonView data={step.output} />
            </div>
          )}
          {step.error && (
            <div className="catamorphic-run-step-section">
              <span className="catamorphic-detail-section-label">Error</span>
              <pre className="catamorphic-run-error-text">{step.error}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function RunRow({
  run,
  expanded,
  onToggle,
}: {
  run: PlaygroundRun;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      className={`catamorphic-run-row ${expanded ? "catamorphic-run-row-open" : ""}`}
    >
      <button
        type="button"
        className="catamorphic-run-row-header"
        onClick={onToggle}
      >
        <Chevron open={expanded} />
        <StatusBadge status={run.status} />
        <span className="catamorphic-run-row-time">
          {formatTime(run.startedAt)}
        </span>
        <span className="catamorphic-run-step-duration">
          {formatDuration(run.startedAt, run.completedAt)}
        </span>
      </button>

      {expanded && (
        <div className="catamorphic-run-row-body">
          {run.error && (
            <div className="catamorphic-run-row-section">
              <span className="catamorphic-detail-section-label">Error</span>
              <pre className="catamorphic-run-error-text">{run.error}</pre>
            </div>
          )}

          {run.result !== undefined && run.result !== null && (
            <div className="catamorphic-run-row-section">
              <span className="catamorphic-detail-section-label">Result</span>
              <JsonView data={run.result} />
            </div>
          )}

          {run.steps.length > 0 && (
            <div className="catamorphic-run-tree">
              <span className="catamorphic-detail-section-label">
                Steps ({run.steps.length})
              </span>
              <div className="catamorphic-run-tree-list">
                {run.steps.map((step) => (
                  <StepRow
                    key={`${step.nodeId}-${step.startedAt}`}
                    step={step}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function RunsPanel() {
  const runs = useAtomValue(runsAtom);
  const setRuns = useSetAtom(runsAtom);
  const activeRunId = useAtomValue(activeRunIdAtom);
  const loadMore = useAtomValue(loadMoreRunsAtom);

  // Expand only the actively running/just-completed run; DB-loaded runs start collapsed.
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const sentinelRef = useRef<HTMLDivElement>(null);

  // When a new run is triggered in this session, auto-expand it.
  const prevActiveRunId = useRef<string | null>(null);
  useEffect(() => {
    if (activeRunId && activeRunId !== prevActiveRunId.current) {
      prevActiveRunId.current = activeRunId;
      setExpandedId(activeRunId);
    }
  }, [activeRunId]);

  // Determine hasMore based on whether we received a full page on initial load.
  useEffect(() => {
    if (loadMore && runs.length >= 20) {
      setHasMore(true);
    }
  }, [loadMore, runs.length]);

  const handleLoadMore = useCallback(async () => {
    if (!loadMore || isLoadingMore || !hasMore) return;
    setIsLoadingMore(true);
    try {
      const result = await loadMore(runs.length);
      if (result.items.length > 0) {
        setRuns((prev) => [...prev, ...result.items]);
        setHasMore(result.hasMore);
      } else {
        setHasMore(false);
      }
    } finally {
      setIsLoadingMore(false);
    }
  }, [loadMore, isLoadingMore, hasMore, runs.length, setRuns]);

  // Infinite scroll sentinel
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !loadMore) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && hasMore && !isLoadingMore) {
          handleLoadMore();
        }
      },
      { threshold: 0.1 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loadMore, hasMore, isLoadingMore, handleLoadMore]);

  if (runs.length === 0) {
    return (
      <div className="catamorphic-run-empty">
        <div className="catamorphic-run-empty-icon">▶</div>
        <p>No runs yet</p>
        <p className="catamorphic-run-empty-hint">
          Click Run in the toolbar to execute this workflow
        </p>
      </div>
    );
  }

  return (
    <div className="catamorphic-runs-panel">
      {runs.map((run) => (
        <RunRow
          key={run.id}
          run={run}
          expanded={run.id === expandedId}
          onToggle={() =>
            setExpandedId((prev) => (prev === run.id ? null : run.id))
          }
        />
      ))}
      {loadMore && (
        <div ref={sentinelRef} className="catamorphic-runs-sentinel">
          {isLoadingMore && (
            <span className="catamorphic-runs-loading">Loading…</span>
          )}
        </div>
      )}
    </div>
  );
}
