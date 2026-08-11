import type { Run } from "@catamorphic/react/types";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WorkflowEditor } from "./workflow-editor.js";

const SAMPLE_CODE = `export const sample = defineWorkflow(({ defineBoundary }) => ({
  steps: [defineBoundary({ run: () => ({ success: true }) })],
}));
`;

function makeRun(): Run {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    projectId: "00000000-0000-0000-0000-000000000002",
    workflowName: "sample",
    correlationKey: null,
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
    provenance: { commitSha: "a".repeat(40) },
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
  it("shows a single Run action that starts a production Run", () => {
    render(
      <WorkflowEditor
        code={SAMPLE_CODE}
        onCodeChange={() => {}}
        onRun={async () => makeRun()}
      />,
    );

    expect(screen.getByRole("button", { name: "Run" })).toBeEnabled();
    expect(
      screen.queryByRole("button", { name: "Test" }),
    ).not.toBeInTheDocument();
  });

  it("hands the canonical submitted Run to the unified Runs pane", async () => {
    const run = makeRun();
    const onRun = vi.fn().mockResolvedValue(run);
    render(
      <WorkflowEditor
        code={SAMPLE_CODE}
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
