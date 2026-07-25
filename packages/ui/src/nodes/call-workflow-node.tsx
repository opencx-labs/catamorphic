import type { WorkflowNode } from "@catamorphic/parser";
import { Handle, type NodeProps, Position } from "@xyflow/react";
import { Workflow } from "lucide-react";
import { ContainerToggle } from "./container-toggle.js";

export function CallWorkflowNode({ data }: NodeProps) {
  const node = data as unknown as WorkflowNode & {
    depth?: number;
    collapsed?: boolean;
    hasChildren?: boolean;
  };
  const nestLevel = Math.min(node.depth ?? 0, 3);
  const borderOpacity = 0.48 + nestLevel * 0.1;
  const collapsed = node.collapsed ?? false;

  return (
    <div
      className={`catamorphic-call-workflow-scope${collapsed ? " catamorphic-container-collapsed" : ""}`}
      style={{
        width: "100%",
        height: "100%",
        borderColor: `rgba(99, 102, 241, ${borderOpacity})`,
      }}
      data-collapsed={collapsed}
    >
      <Handle type="target" position={Position.Top} />
      <div className="catamorphic-call-workflow-header">
        <Workflow aria-hidden="true" size={15} strokeWidth={1.8} />
        <span>{node.label}</span>
      </div>
      {node.hasChildren && (
        <ContainerToggle
          nodeId={node.id}
          collapsed={collapsed}
          label={node.label}
        />
      )}
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
