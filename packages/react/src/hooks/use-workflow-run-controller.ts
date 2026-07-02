"use client";

import type { WorkflowGraph } from "@catamorphic/parser";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useCallback } from "react";
import {
  activeHistoryTabAtom,
  activeRunIdAtom,
  executionStateAtom,
  graphAtom,
  historySidebarOpenAtom,
  isRunningAtom,
  lastTriggerDataAtom,
  runsAtom,
  showRunDialogAtom,
} from "../atoms.js";
import type { PlaygroundRun, PlaygroundRunStep } from "../run-types.js";

export interface TriggerRunResult {
  runId?: string | null;
  status: "completed" | "failed";
  result?: unknown;
  error?: string | null;
  steps: PlaygroundRunStep[];
  startedAt: string;
  completedAt: string;
}

export type TriggerRunFn = (
  triggerData: Record<string, unknown>,
) => Promise<TriggerRunResult>;

export interface UseWorkflowRunControllerOptions {
  /**
   * Executes the run against the host transport (HTTP, SDK, fixture, …) and
   * returns the terminal result. The controller owns optimistic UI + the
   * canvas execution-state machine; this callback is purely I/O.
   */
  onTriggerRun?: TriggerRunFn;
  /**
   * Optional override for the currently-loaded graph. Defaults to reading
   * `graphAtom` so the controller stays in sync with whatever the canvas is
   * showing.
   */
  graph?: WorkflowGraph | null;
}

export interface UseWorkflowRunControllerResult {
  /** True while a submission is in flight. Mirrors `isRunningAtom`. */
  isRunning: boolean;
  /** True when the Run dialog should be visible. Mirrors `showRunDialogAtom`. */
  showDialog: boolean;
  /** Opens the Run dialog imperatively (no-op if no `onTriggerRun`). */
  openDialog: () => void;
  /** Closes the Run dialog. */
  closeDialog: () => void;
  /**
   * Submits a run. Performs optimistic run insertion, flips the canvas into
   * the "running" execution state, awaits `onTriggerRun`, then reconciles the
   * run list + execution state with the result (or a failure record).
   */
  submit: (triggerData: Record<string, unknown>) => Promise<void>;
}

/**
 * Owns the client-side run lifecycle for the workflow editor: optimistic
 * insertion into `runsAtom`, execution-state painting on the canvas, history
 * sidebar toggling, and failure cleanup. The actual run dispatch is delegated
 * to `onTriggerRun`, which is typically wired to `@catamorphic/server-sdk` or an
 * HTTP endpoint by the embedder.
 *
 * This hook intentionally has no UI of its own. Mount it anywhere inside a
 * `<CatamorphicProvider>` + jotai scope that also hosts the canvas.
 */
export function useWorkflowRunController(
  options: UseWorkflowRunControllerOptions = {},
): UseWorkflowRunControllerResult {
  const { onTriggerRun, graph: graphOverride } = options;
  const canvasGraph = useAtomValue(graphAtom);
  const graph = graphOverride ?? canvasGraph;

  const setRuns = useSetAtom(runsAtom);
  const setActiveRunId = useSetAtom(activeRunIdAtom);
  const [isRunning, setIsRunning] = useAtom(isRunningAtom);
  const [showDialog, setShowDialog] = useAtom(showRunDialogAtom);
  const setHistorySidebarOpen = useSetAtom(historySidebarOpenAtom);
  const setActiveHistoryTab = useSetAtom(activeHistoryTabAtom);
  const setExecutionState = useSetAtom(executionStateAtom);
  const setLastTriggerData = useSetAtom(lastTriggerDataAtom);

  const openDialog = useCallback(() => {
    if (!onTriggerRun) return;
    setShowDialog(true);
  }, [onTriggerRun, setShowDialog]);

  const closeDialog = useCallback(() => {
    setShowDialog(false);
  }, [setShowDialog]);

  const submit = useCallback(
    async (triggerData: Record<string, unknown>) => {
      if (!onTriggerRun) return;
      setLastTriggerData(triggerData);

      const runId = crypto.randomUUID();
      const workflowName = graph?.name ?? "unknown";
      const startedAt = new Date().toISOString();

      const pendingRun: PlaygroundRun = {
        id: runId,
        workflowName,
        status: "running",
        triggerData,
        steps: [],
        startedAt,
      };

      setRuns((prev) => [pendingRun, ...prev]);
      setActiveRunId(runId);
      setIsRunning(true);
      setShowDialog(false);
      setHistorySidebarOpen(true);
      setActiveHistoryTab("runs");

      const nodes = graph?.nodes ?? [];
      const runningState: Record<string, string> = {};
      for (const node of nodes) {
        if (
          node.type === "step" ||
          node.type === "trigger" ||
          node.type === "return"
        ) {
          runningState[node.id] = "running";
        }
      }
      setExecutionState(runningState);

      try {
        const result = await onTriggerRun(triggerData);
        const finalId = result.runId ?? runId;

        const completedRun: PlaygroundRun = {
          id: finalId,
          workflowName,
          status: result.status,
          triggerData,
          result: result.result,
          error: result.error ?? undefined,
          steps: result.steps,
          startedAt: result.startedAt,
          completedAt: result.completedAt,
        };

        setRuns((prev) => prev.map((r) => (r.id === runId ? completedRun : r)));
        setActiveRunId(finalId);

        const execState: Record<string, string> = {};
        for (const step of result.steps) {
          execState[step.nodeId] = step.status;
        }
        const triggerNode = nodes.find((n) => n.type === "trigger");
        if (triggerNode) {
          execState[triggerNode.id] = result.status;
        }
        const returnNode = nodes.find((n) => n.type === "return");
        if (returnNode) {
          execState[returnNode.id] = result.status;
        }
        setExecutionState(execState);
      } catch (err) {
        const failedRun: PlaygroundRun = {
          id: runId,
          workflowName,
          status: "failed",
          triggerData,
          error: err instanceof Error ? err.message : String(err),
          steps: [],
          startedAt,
          completedAt: new Date().toISOString(),
        };

        setRuns((prev) => prev.map((r) => (r.id === runId ? failedRun : r)));
        setExecutionState({});
      } finally {
        setIsRunning(false);
      }
    },
    [
      onTriggerRun,
      graph,
      setRuns,
      setActiveRunId,
      setIsRunning,
      setShowDialog,
      setHistorySidebarOpen,
      setActiveHistoryTab,
      setExecutionState,
      setLastTriggerData,
    ],
  );

  return {
    isRunning,
    showDialog,
    openDialog,
    closeDialog,
    submit,
  };
}
