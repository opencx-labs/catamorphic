import type { WorkflowNode } from "@catamorphic/parser";
import { Handle, type NodeProps, Position } from "@xyflow/react";
import { NodeIcon } from "./node-icon.js";

export function StepNode({ data }: NodeProps) {
  const node = data as unknown as WorkflowNode & { executionStatus?: string };
  const isBatchStep = node.metadata?.batchStep === "true";
  const batchSize = node.metadata?.["batch:maxItems"];
  const batchWait = node.metadata?.["batch:maxWaitMs"];

  return (
    <div
      className={`catamorphic-node catamorphic-step-node${isBatchStep ? " catamorphic-batch-step-node" : ""}`}
      data-execution-status={node.executionStatus}
    >
      <Handle type="target" position={Position.Top} />
      {node.executionStatus && (
        <span
          className="catamorphic-node-exec-indicator"
          data-status={node.executionStatus}
        />
      )}
      <div className="catamorphic-node-icon">
        <NodeIcon name={node.metadata?.icon} />
      </div>
      <div className="catamorphic-node-content">
        <div className="catamorphic-node-label">{node.label}</div>
        {isBatchStep && (
          <div className="catamorphic-node-description">
            Batch
            {batchSize ? ` · ${batchSize} items` : ""}
            {batchWait ? ` · ${batchWait}ms` : ""}
          </div>
        )}
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
