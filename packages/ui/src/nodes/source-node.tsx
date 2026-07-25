import { Handle, type NodeProps, Position } from "@xyflow/react";

export function SourceNode({ data }: NodeProps) {
  const executionStatus =
    typeof data.executionStatus === "string" ? data.executionStatus : undefined;

  return (
    <div
      className="catamorphic-node catamorphic-source-node"
      data-execution-status={executionStatus}
    >
      {executionStatus && (
        <span
          className="catamorphic-node-exec-indicator"
          data-status={executionStatus}
        />
      )}
      <div className="catamorphic-node-icon">◉</div>
      <div className="catamorphic-node-content">
        <div className="catamorphic-node-label">Batch source</div>
        <div className="catamorphic-node-description">Loads Items in pages</div>
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
