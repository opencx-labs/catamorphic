import type { WorkflowNode } from "@catamorphic/parser";
import { Handle, type NodeProps, Position } from "@xyflow/react";
import { Boxes } from "lucide-react";
import { ContainerToggle } from "./container-toggle.js";

export function BatchNode({ data }: NodeProps) {
  const node = data as unknown as WorkflowNode & {
    collapsed?: boolean;
    hasChildren?: boolean;
  };
  const collapsed = node.collapsed ?? false;
  const label =
    node.label && node.label !== "Batch" ? node.label : "Batch processing";

  return (
    <div
      className={`catamorphic-batch-node${collapsed ? " catamorphic-container-collapsed" : ""}`}
      data-testid="batch"
      data-collapsed={collapsed}
      style={{ width: "100%", height: "100%" }}
    >
      <Handle type="target" position={Position.Top} />
      <div className="catamorphic-batch-header">
        <span className="catamorphic-batch-icon">
          <Boxes aria-hidden="true" size={14} strokeWidth={1.8} />
        </span>
        <span className="catamorphic-batch-label">{label}</span>
      </div>
      {node.hasChildren && (
        <ContainerToggle nodeId={node.id} collapsed={collapsed} label={label} />
      )}
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
