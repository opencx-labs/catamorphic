import type { WorkflowNode } from "@catamorphic/parser";
import { Handle, type NodeProps, Position } from "@xyflow/react";
import { Split } from "lucide-react";

export function ParallelBlockNode({ data }: NodeProps) {
  const node = data as unknown as WorkflowNode & { depth?: number };
  const nestLevel = Math.min(node.depth ?? 0, 3);

  return (
    <div
      className="catamorphic-parallel-block-node"
      style={{
        width: "100%",
        height: "100%",
      }}
      data-depth={nestLevel}
    >
      <Handle type="target" position={Position.Top} />
      <div className="catamorphic-parallel-block-header">
        <span className="catamorphic-parallel-block-icon">
          <Split aria-hidden="true" size={13} strokeWidth={1.8} />
        </span>
        <span className="catamorphic-parallel-block-label">{node.label}</span>
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
