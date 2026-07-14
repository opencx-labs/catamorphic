import { Handle, type NodeProps, Position } from "@xyflow/react";

export function SinkNode({ data }: NodeProps) {
  const executionStatus =
    typeof data.executionStatus === "string" ? data.executionStatus : undefined;

  return (
    <div
      className="catamorphic-node catamorphic-sink-node"
      data-execution-status={executionStatus}
    >
      <Handle type="target" position={Position.Top} />
      {executionStatus && (
        <span
          className="catamorphic-node-exec-indicator"
          data-status={executionStatus}
        />
      )}
      <div className="catamorphic-node-icon">⇩</div>
      <div className="catamorphic-node-content">
        <div className="catamorphic-node-label">Batch sink</div>
        <div className="catamorphic-node-description">
          Writes results and finalizes output
        </div>
      </div>
    </div>
  );
}
