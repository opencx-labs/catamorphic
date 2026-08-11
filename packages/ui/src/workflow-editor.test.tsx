import type { WorkflowGraph } from "@catamorphic/react";
import type { Run } from "@catamorphic/react/types";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WorkflowEditor } from "./workflow-editor.js";

function makeGraph({
  persistedContinuations,
}: {
  persistedContinuations: boolean;
}): WorkflowGraph {
  return {
    name: "sample",
    capabilities: {
      persistedContinuations,
      batchProcessing: persistedContinuations,
      cancellation: persistedContinuations,
    },
    filePath: "workflows/sample.ts",
    input: { parameters: [] },
    triggers: [],
    canSuspend: false,
    nodes: [],
    edges: [],
    sourceCode: "",
  };
}

function makeRun(): Run {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    projectId: "00000000-0000-0000-0000-000000000002",
    workflowName: "sample",
    capabilities: {
      cancel: true,
      pauseProcessing: false,
      resumeProcessing: false,
      submitInput: false,
      inspectItems: false,
    },
    status: "pending",
    phase: "execute",
    currentStepIndex: null,
    activePause: null,
    batchScopes: [],
    provenance: { mutableSource: true },
    mode: "test",
    initiatedBy: "user-1",
    input: {},
    result: null,
    error: null,
    parentRunId: null,
    createdAt: "2026-07-25T12:00:00.000Z",
    updatedAt: "2026-07-25T12:00:00.000Z",
    startedAt: null,
    completedAt: null,
  };
}

describe("WorkflowEditor runs", () => {
  it("uses live graph capabilities for the Test action", async () => {
    const onTestRun = vi.fn().mockResolvedValue(makeRun());
    const graph = makeGraph({ persistedContinuations: false });
    render(
      <WorkflowEditor
        code={'export async function sample() { "use workflow"; }'}
        onCodeChange={() => {}}
        workflowCapabilities={
          makeGraph({ persistedContinuations: true }).capabilities
        }
        onParse={async () => ({
          graph,
          layoutedNodes: [],
          layoutedEdges: [],
        })}
        onRun={async () => makeRun()}
        onTestRun={onTestRun}
      />,
    );

    const testButton = screen.getByRole("button", { name: "Test" });
    expect(testButton).toBeDisabled();
    await waitFor(() => expect(testButton).toBeEnabled());
  });

  it("hands the canonical submitted Run to the unified Runs pane", async () => {
    const run = makeRun();
    const onRun = vi.fn().mockResolvedValue(run);
    render(
      <WorkflowEditor
        code={'export async function sample() { "use workflow"; }'}
        onCodeChange={() => {}}
        onRun={onRun}
        renderRunsPanel={({ activeRun }) => (
          <div>Active Run: {activeRun?.id ?? "none"}</div>
        )}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    fireEvent.click(screen.getByRole("button", { name: "Start Run" }));

    await waitFor(() => expect(onRun).toHaveBeenCalledWith({}));
    expect(
      await screen.findByText(`Active Run: ${run.id}`),
    ).toBeInTheDocument();
  });
});
