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

const SAMPLE_GRAPH = {
  name: "sample",
  displayName: null,
  description: null,
  filePath: "workflows/sample.ts",
  trigger: { parameters: [] },
  nodes: [
    { id: "trigger", type: "trigger", label: "start", metadata: {} },
    { id: "step-1", type: "step", label: "step1", metadata: {} },
    { id: "return", type: "return", label: "end", metadata: {} },
  ],
  edges: [],
  sourceCode: "",
} as const;

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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const [, setGraph] = useAtom(graphAtom);
      const [runs] = useAtom(runsAtom);
      const [activeRunId] = useAtom(activeRunIdAtom);
      const [historyOpen] = useAtom(historySidebarOpenAtom);
      const controller = useWorkflowRunController({ onTriggerRun });
      return { setGraph, runs, activeRunId, historyOpen, controller };
    });

    act(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      result.current.setGraph(SAMPLE_GRAPH as any);
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      result.current.setGraph(SAMPLE_GRAPH as any);
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
