import { render, screen } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import { BatchNode } from "./batch-node.js";
import { BoundaryNode } from "./boundary-node.js";
import { CallWorkflowNode } from "./call-workflow-node.js";
import { PauseNode } from "./pause-node.js";

function nodeProps(data: Record<string, unknown>) {
  return {
    id: "node-1",
    data,
    type: "test",
    selected: false,
    dragging: false,
    draggable: false,
    selectable: true,
    deletable: false,
    zIndex: 0,
    isConnectable: false,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
  };
}

describe("workflow scope nodes", () => {
  it("renders a nameless retry scope", () => {
    render(
      <ReactFlowProvider>
        <BoundaryNode {...nodeProps({ depth: 0, metadata: {} })} />
      </ReactFlowProvider>,
    );
    expect(screen.getByTestId("boundary")).toHaveTextContent("");
  });

  it("renders retry scope JSDoc metadata", () => {
    render(
      <ReactFlowProvider>
        <BoundaryNode
          {...nodeProps({
            depth: 0,
            label: "Request Approval",
            metadata: { icon: "badge-check" },
          })}
        />
      </ReactFlowProvider>,
    );
    expect(screen.getByText("Request Approval")).toBeInTheDocument();
  });

  it("renders human-readable waiting, child, and batch labels", () => {
    render(
      <ReactFlowProvider>
        <PauseNode {...nodeProps({ label: "Pause with timeout" })} />
        <BatchNode
          {...nodeProps({
            id: "batch-1",
            label: "Batch",
            hasChildren: true,
            collapsed: false,
          })}
        />
        <CallWorkflowNode
          {...nodeProps({
            id: "call-1",
            label: "Call Finish Order",
            hasChildren: true,
            collapsed: false,
          })}
        />
      </ReactFlowProvider>,
    );
    expect(screen.getByText("Waiting for input")).toBeInTheDocument();
    expect(screen.getByText("Batch processing")).toBeInTheDocument();
    expect(screen.getByText("Call Finish Order")).toBeInTheDocument();
    expect(
      screen.getByLabelText("Collapse Call Finish Order"),
    ).toBeInTheDocument();
  });

  it("renders collapsed scopes as compact labeled cards", () => {
    render(
      <ReactFlowProvider>
        <BoundaryNode
          {...nodeProps({
            id: "boundary-1",
            label: "Request Approval",
            metadata: { icon: "badge-check" },
            hasChildren: true,
            collapsed: true,
          })}
        />
        <CallWorkflowNode
          {...nodeProps({
            id: "call-1",
            label: "Call Finish Order",
            hasChildren: true,
            collapsed: true,
          })}
        />
        <BatchNode
          {...nodeProps({
            id: "batch-1",
            label: "Batch",
            hasChildren: true,
            collapsed: true,
          })}
        />
      </ReactFlowProvider>,
    );

    expect(screen.getByText("Request Approval")).toBeInTheDocument();
    expect(screen.getByText("Call Finish Order")).toBeInTheDocument();
    expect(screen.getByText("Batch processing")).toBeInTheDocument();
    expect(screen.queryByText("Checkpoint")).not.toBeInTheDocument();
    expect(screen.queryByText("Child workflow")).not.toBeInTheDocument();
    expect(
      screen.getByLabelText("Expand Request Approval"),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText("Expand Call Finish Order"),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText("Expand Batch processing"),
    ).toBeInTheDocument();
  });
});
