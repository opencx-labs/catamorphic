import type { RunDetail, RunItem } from "@catamorphic/react/types";
import { fireEvent, render, screen } from "@testing-library/react";
import { atom, Provider as JotaiProvider } from "jotai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RunsPanel } from "./runs-panel.js";

const cancel = vi.fn();
const pause = vi.fn();
const resume = vi.fn();
const submit = vi.fn();
const mocks = vi.hoisted(() => ({
  useRunItems: vi.fn(),
  useRunItemSteps: vi.fn(),
}));

const FIRST_SCOPE_ID = "00000000-0000-0000-0000-000000000004";
const SECOND_SCOPE_ID = "00000000-0000-0000-0000-000000000008";

const detail: RunDetail = {
  id: "00000000-0000-0000-0000-000000000001",
  projectId: "00000000-0000-0000-0000-000000000002",
  workflowName: "processOrders",
  correlationKey: null,
  capabilities: {
    cancel: true,
    pauseProcessing: false,
    resumeProcessing: false,
    submitInput: true,
    inspectItems: true,
  },
  status: "waiting",
  phase: "pause",
  currentStepIndex: 1,
  activePause: {
    id: "00000000-0000-0000-0000-000000000003",
    status: "open",
    state: { orderId: "order-1" },
    timeoutAt: null,
    createdAt: "2026-07-25T12:00:00.000Z",
    resolvedAt: null,
  },
  batchScopes: [
    {
      workflowStepAttemptId: FIRST_SCOPE_ID,
      stepIndex: 0,
      nodeId: "prepare-batch",
      attempt: 1,
      status: "completed",
      estimated: 2,
      discovered: 2,
      succeeded: 2,
      failed: 0,
      skipped: 0,
      sinkCompletedChunks: 0,
      sinkTotalChunks: 0,
      artifact: null,
    },
    {
      workflowStepAttemptId: SECOND_SCOPE_ID,
      stepIndex: 1,
      nodeId: "charge-batch",
      attempt: 1,
      status: "waiting",
      estimated: 4,
      discovered: 4,
      succeeded: 2,
      failed: 1,
      skipped: 0,
      sinkCompletedChunks: 0,
      sinkTotalChunks: 0,
      artifact: null,
    },
  ],
  provenance: { commitSha: "a".repeat(40) },
  initiatedBy: "user-1",
  input: { accountId: "account-1" },
  result: null,
  error: null,
  parentRunId: null,
  createdAt: "2026-07-25T12:00:00.000Z",
  updatedAt: "2026-07-25T12:00:01.000Z",
  startedAt: "2026-07-25T12:00:00.000Z",
  completedAt: null,
  steps: [],
  workflowStepAttempts: [
    {
      id: "00000000-0000-0000-0000-000000000005",
      runId: "00000000-0000-0000-0000-000000000001",
      stepIndex: 0,
      nodeId: "prepare",
      executor: "boundary",
      attempt: 2,
      status: "completed",
      input: null,
      output: null,
      error: null,
      startedAt: "2026-07-25T12:00:00.000Z",
      completedAt: "2026-07-25T12:00:01.000Z",
    },
  ],
};

const item: RunItem = {
  id: "00000000-0000-0000-0000-000000000006",
  runId: detail.id,
  workflowStepAttemptId: SECOND_SCOPE_ID,
  key: "order-1",
  sourceOrder: 0,
  status: "failed",
  value: { orderId: "order-1" },
  output: null,
  error: "Payment declined",
  currentNodeId: "charge",
  attempt: 2,
  createdAt: "2026-07-25T12:00:00.000Z",
  updatedAt: "2026-07-25T12:00:01.000Z",
  completedAt: "2026-07-25T12:00:01.000Z",
};

vi.mock("@catamorphic/react", () => ({
  selectedNodeIdAtom: atom<string | null>(null),
  useRuns: () => ({ data: { items: [detail], total: 1 } }),
  useRun: () => ({ data: detail }),
  useRunItems: mocks.useRunItems,
  useRunItemSteps: mocks.useRunItemSteps,
  useCancelRun: () => ({ mutate: cancel, isPending: false }),
  usePauseRunProcessing: () => ({ mutate: pause, isPending: false }),
  useResumeRunProcessing: () => ({ mutate: resume, isPending: false }),
  useSubmitRunInput: () => ({ mutate: submit, isPending: false }),
}));

describe("RunsPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useRunItems.mockReturnValue({
      data: { items: [item], total: 1 },
    });
    mocks.useRunItemSteps.mockReturnValue({
      data: [
        {
          id: "00000000-0000-0000-0000-000000000007",
          itemId: item.id,
          nodeId: "charge",
          occurrence: 0,
          attempt: 2,
          name: "Charge payment",
          status: "failed",
          input: null,
          output: null,
          error: "Payment declined",
          startedAt: "2026-07-25T12:00:00.000Z",
          completedAt: "2026-07-25T12:00:01.000Z",
        },
      ],
    });
  });

  it("shows one capability-driven Run detail", () => {
    render(
      <JotaiProvider>
        <RunsPanel projectId={detail.projectId} workflowName="processOrders" />
      </JotaiProvider>,
    );

    expect(screen.getAllByText("Waiting for input").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Cancel Run" })).toBeEnabled();
    expect(screen.queryByText("Pause processing")).not.toBeInTheDocument();
    expect(screen.getByText("Batch processing")).toBeInTheDocument();
    expect(screen.getByText("Batch processing, step 2")).toBeInTheDocument();
    expect(screen.getByText("Retry scope")).toBeInTheDocument();
  });

  it("defaults to the current Batch processing scope and allows prior scopes", () => {
    render(
      <JotaiProvider>
        <RunsPanel projectId={detail.projectId} workflowName="processOrders" />
      </JotaiProvider>,
    );

    const selector = screen.getByLabelText("Batch processing scope");
    expect(selector).toHaveValue(SECOND_SCOPE_ID);
    fireEvent.change(selector, { target: { value: FIRST_SCOPE_ID } });
    expect(selector).toHaveValue(FIRST_SCOPE_ID);
    expect(mocks.useRunItems).toHaveBeenLastCalledWith(
      expect.objectContaining({
        run: detail,
        workflowStepAttemptId: FIRST_SCOPE_ID,
      }),
    );
  });

  it("submits input and opens Item history", () => {
    render(
      <JotaiProvider>
        <RunsPanel projectId={detail.projectId} workflowName="processOrders" />
      </JotaiProvider>,
    );

    fireEvent.change(screen.getByLabelText("Run input"), {
      target: { value: '{"approved":true}' },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit input" }));
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({ value: { approved: true } }),
    );

    fireEvent.click(screen.getByRole("button", { name: /order-1/i }));
    expect(mocks.useRunItemSteps).toHaveBeenLastCalledWith(
      expect.objectContaining({ run: detail, itemId: item.id }),
    );
    expect(screen.getByText("Item history")).toBeInTheDocument();
    expect(screen.getByText("Charge payment")).toBeInTheDocument();
  });
});
