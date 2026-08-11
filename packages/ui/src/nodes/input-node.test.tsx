import { render, screen } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import { InputNode } from "./input-node.js";

function nodeProps(data: Record<string, unknown>) {
  return {
    id: "node-1",
    data,
    type: "input",
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

describe("input node trigger badges", () => {
  it("renders one badge per trigger binding", () => {
    render(
      <ReactFlowProvider>
        <InputNode
          {...nodeProps({
            label: "Order Received",
            metadata: {},
            triggerBindings: [
              {
                kind: "webhook",
                config: { path: "/orders" },
                display: { label: "Webhook", icon: "globe", color: "#0891b2" },
              },
              { kind: "cron", config: "0 * * * *" },
            ],
          })}
        />
      </ReactFlowProvider>,
    );

    expect(screen.getByText("Order Received")).toBeInTheDocument();
    expect(screen.getByText("Webhook")).toBeInTheDocument();
    expect(screen.getByText("cron")).toBeInTheDocument();
  });

  it("renders no badge row without bindings", () => {
    const { container } = render(
      <ReactFlowProvider>
        <InputNode {...nodeProps({ label: "Start", metadata: {} })} />
      </ReactFlowProvider>,
    );

    expect(screen.getByText("Start")).toBeInTheDocument();
    expect(
      container.querySelector(".catamorphic-node-triggers"),
    ).not.toBeInTheDocument();
  });
});
