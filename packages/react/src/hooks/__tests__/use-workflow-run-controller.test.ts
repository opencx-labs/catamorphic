import type { WorkflowGraph } from "@catamorphic/parser";
import { act, waitFor } from "@testing-library/react";
import { useAtom } from "jotai";
import { describe, expect, it, vi } from "vitest";
import {
  activeRunIdAtom,
  graphAtom,
  historySidebarOpenAtom,
  runsAtom,
} from "../../atoms.js";
import { renderHookWithProviders } from "../../test/render.js";
import { useWorkflowRunController } from "../use-workflow-run-controller.js";

const SAMPLE_RANGE = {
  start: 0,
  end: 0,
  startLine: 1,
  startColumn: 0,
  endLine: 1,
  endColumn: 0,
};

const SAMPLE_GRAPH: WorkflowGraph = {
  name: "sample",
  filePath: "workflows/sample.ts",
  trigger: { parameters: [] },
  nodes: [
    {
      id: "trigger",
      type: "trigger",
      label: "start",
      metadata: {},
      sourceRange: SAMPLE_RANGE,
    },
    {
      id: "step-1",
      type: "step",
      label: "step1",
      metadata: {},
      sourceRange: SAMPLE_RANGE,
    },
    {
      id: "return",
      type: "return",
      label: "end",
      metadata: {},
      sourceRange: SAMPLE_RANGE,
    },
  ],
  edges: [],
  sourceCode: "",
};

describe("useWorkflowRunController", () => {
  it("optimistically inserts a run and reconciles on success", async () => {
    const onTriggerRun = vi.fn().mockResolvedValue({
      runId: "run-final",
      status: "completed" as const,
      result: { ok: true },
      error: null,
      steps: [
        {
          nodeId: "step-1",
          name: "step1",
          status: "completed" as const,
          startedAt: "2024-01-01T00:00:00.000Z",
          completedAt: "2024-01-01T00:00:01.000Z",
        },
      ],
      startedAt: "2024-01-01T00:00:00.000Z",
      completedAt: "2024-01-01T00:00:02.000Z",
    });

    const { result } = renderHookWithProviders(() => {
      const [, setGraph] = useAtom(graphAtom);
      const [runs] = useAtom(runsAtom);
      const [activeRunId] = useAtom(activeRunIdAtom);
      const [historyOpen] = useAtom(historySidebarOpenAtom);
      const controller = useWorkflowRunController({ onTriggerRun });
      return { setGraph, runs, activeRunId, historyOpen, controller };
    });

    act(() => {
      result.current.setGraph(SAMPLE_GRAPH);
    });

    await act(async () => {
      await result.current.controller.submit({ foo: "bar" });
    });

    await waitFor(() => expect(result.current.runs).toHaveLength(1));
    expect(result.current.runs[0]?.status).toBe("completed");
    expect(result.current.activeRunId).toBe("run-final");
    expect(result.current.historyOpen).toBe(true);
    expect(onTriggerRun).toHaveBeenCalledWith({ foo: "bar" });
  });

  it("marks the run as failed when onTriggerRun throws", async () => {
    const onTriggerRun = vi.fn().mockRejectedValue(new Error("nope"));
    const { result } = renderHookWithProviders(() => {
      const [, setGraph] = useAtom(graphAtom);
      const [runs] = useAtom(runsAtom);
      const controller = useWorkflowRunController({ onTriggerRun });
      return { setGraph, runs, controller };
    });

    act(() => {
      result.current.setGraph(SAMPLE_GRAPH);
    });

    await act(async () => {
      await result.current.controller.submit({});
    });

    await waitFor(() => expect(result.current.runs).toHaveLength(1));
    expect(result.current.runs[0]?.status).toBe("failed");
    expect(result.current.runs[0]?.error).toBe("nope");
  });

  it("openDialog / closeDialog flip showDialog", async () => {
    const onTriggerRun = vi.fn();
    const { result } = renderHookWithProviders(() =>
      useWorkflowRunController({ onTriggerRun }),
    );

    expect(result.current.showDialog).toBe(false);
    act(() => result.current.openDialog());
    expect(result.current.showDialog).toBe(true);
    act(() => result.current.closeDialog());
    expect(result.current.showDialog).toBe(false);
  });
});
